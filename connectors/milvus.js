/**
 * connectors/milvus.js — Milvus / Zilliz vector store
 * Requires: @zilliz/milvus2-sdk-node (npm install @zilliz/milvus2-sdk-node)
 *
 * Usage:
 *   vex migrate --from vektor --to milvus --milvus-url localhost:19530 --collection vex_memory
 *   vex migrate --from vektor --to milvus --milvus-url https://xxx.zillizcloud.com --milvus-token TOKEN --collection vex_memory
 *
 * Zilliz Cloud: use --milvus-url <endpoint> --milvus-token <api-key>
 * Local Milvus: use --milvus-url localhost:19530 (no token needed)
 */

import { toRecord } from '../formats/vmig.js';
import { createRequire } from 'module';

const require        = createRequire(import.meta.url);
const DEFAULT_URL    = 'localhost:19530';
const DEFAULT_COLL   = 'vex_memory';
const VECTOR_DIM     = 1536;
const BATCH_SIZE     = 100;

function getClient(opts) {
  try {
    const { MilvusClient } = require('@zilliz/milvus2-sdk-node');
    const address = opts['milvus-url'] || opts.url || process.env.MILVUS_URL || DEFAULT_URL;
    const token   = opts['milvus-token'] || opts['api-key'] || process.env.MILVUS_TOKEN;
    return new MilvusClient({ address, token });
  } catch {
    throw new Error('@zilliz/milvus2-sdk-node not found — run: npm install @zilliz/milvus2-sdk-node');
  }
}

async function ensureCollection(client, collection, dim) {
  const { MilvusClient, DataType } = require('@zilliz/milvus2-sdk-node');
  const exists = await client.hasCollection({ collection_name: collection });
  if (exists.value) return;

  await client.createCollection({
    collection_name: collection,
    fields: [
      { name: 'id',         data_type: DataType.VarChar,  max_length: 256, is_primary_key: true },
      { name: 'content',    data_type: DataType.VarChar,  max_length: 65535 },
      { name: 'namespace',  data_type: DataType.VarChar,  max_length: 128 },
      { name: 'importance', data_type: DataType.Float },
      { name: 'tags',       data_type: DataType.VarChar,  max_length: 512 },
      { name: 'created_at', data_type: DataType.Int64 },
      { name: 'source',     data_type: DataType.VarChar,  max_length: 128 },
      { name: 'vector',     data_type: DataType.FloatVector, dim },
    ],
  });

  // Create IVF_FLAT index on vector field
  await client.createIndex({
    collection_name: collection,
    field_name:      'vector',
    index_type:      'IVF_FLAT',
    metric_type:     'COSINE',
    params:          { nlist: 128 },
  });

  await client.loadCollection({ collection_name: collection });
  console.log(`[milvus] created collection: ${collection} (dim=${dim})`);
}

export const milvusConnector = {
  name: 'milvus',

  async extract(opts) {
    const client     = getClient(opts);
    const collection = opts.collection || DEFAULT_COLL;
    const ns         = opts.namespace;
    const limit      = parseInt(opts.limit || '10000');

    await client.loadCollection({ collection_name: collection });

    const expr    = ns ? `namespace == "${ns}"` : '';
    const res     = await client.query({
      collection_name:  collection,
      filter:           expr || undefined,
      output_fields:    ['id', 'content', 'namespace', 'importance', 'tags', 'created_at', 'vector'],
      limit,
    });

    const records = (res.data || []).map(row => toRecord({
      id:         row.id,
      text:       row.content || '',
      vector:     row.vector  || null,
      namespace:  row.namespace || 'default',
      importance: row.importance || 0.6,
      tags:       row.tags || '',
      created_at: Number(row.created_at || 0),
    }, 'milvus'));

    console.log(`[milvus] extracted ${records.length} records from "${collection}"`);
    return records;
  },

  async load(records, opts) {
    const client     = getClient(opts);
    const collection = opts.collection || DEFAULT_COLL;

    // Detect vector dim from first record with a vector
    const sample = records.find(r => r.vector && r.vector.length);
    const dim    = sample ? sample.vector.length : VECTOR_DIM;

    await ensureCollection(client, collection, dim);

    let upserted = 0;
    let skipped  = 0;

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      const rows  = batch.map(r => ({
        id:         String(r.id).slice(0, 255),
        content:    (r.text || '').slice(0, 65534),
        namespace:  (r.namespace || 'default').slice(0, 127),
        importance: r.metadata?.importance || 0.6,
        tags:       (Array.isArray(r.metadata?.tags)
                      ? r.metadata.tags.join(',')
                      : (r.metadata?.tags || '')).slice(0, 511),
        created_at: r.created_at || Math.floor(Date.now() / 1000),
        source:     (r.source || 'vex').slice(0, 127),
        // Milvus requires a vector -- use zero vector if missing
        vector:     r.vector && r.vector.length === dim
                      ? r.vector
                      : new Array(dim).fill(0),
      }));

      // Skip rows with zero vectors if no embeddings
      const withVec    = rows.filter(r => r.vector.some(v => v !== 0));
      const zeroVec    = rows.length - withVec.length;
      if (zeroVec > 0) {
        console.log(`[milvus] ${zeroVec} records have no vector — using zero vector (text search unavailable for these)`);
      }

      try {
        await client.insert({ collection_name: collection, data: rows });
        upserted += rows.length;
      } catch (e) {
        console.error(`[milvus] batch insert error: ${e.message}`);
        skipped += rows.length;
      }

      process.stdout.write(`\r[milvus] ${Math.min(i + BATCH_SIZE, records.length)}/${records.length}`);
    }

    process.stdout.write('\n');

    // Flush to make records searchable
    await client.flushSync({ collection_names: [collection] });
    console.log(`[milvus] wrote ${upserted} records to "${collection}" (${skipped} failed)`);
    return { upserted, skipped };
  },
};
