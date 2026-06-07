/**
 * connectors/redis.js — Redis / Redis Stack vector store
 * Requires: redis (npm install redis)
 *
 * Usage:
 *   vex migrate --from vektor --to redis --redis-url redis://localhost:6379 --index vex-memory
 *   vex export --from redis --redis-url redis://localhost:6379 --index vex-memory --output out.vmig.jsonl
 */

import { createRequire } from 'module';
import { toRecord } from '../formats/vmig.js';

const _require    = createRequire(import.meta.url);
const DEFAULT_URL  = 'redis://localhost:6379';
const DEFAULT_INDEX = 'vex-memory';
const VECTOR_DIM   = 1536;

function getClient(opts) {
  try {
    const { createClient } = _require('redis');
    const url = opts['redis-url'] || opts.url || process.env.REDIS_URL || DEFAULT_URL;
    return createClient({ url });
  } catch {
    throw new Error('redis package not found — run: npm install redis');
  }
}

export const redisConnector = {
  name: 'redis',

  async extract(opts) {
    const client = getClient(opts);
    await client.connect();

    const index  = opts.index || DEFAULT_INDEX;
    const ns     = opts.namespace;
    const limit  = parseInt(opts.limit || '10000');
    let   records = [];

    try {
      const query = ns ? `@namespace:{${ns}}` : '*';
      const res   = await client.ft.search(index, query, {
        LIMIT: { from: 0, size: limit },
        RETURN: ['id', 'content', 'namespace', 'importance', 'tags', 'created_at', 'vector'],
      });

      records = (res.documents || []).map(doc => {
        const f = doc.value;
        let vector = null;
        if (f.vector) {
          try {
            const buf = Buffer.from(f.vector, 'base64');
            const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
            vector = Array.from(f32);
          } catch {}
        }
        return toRecord({
          id:         doc.id.replace(`${index}:`, ''),
          text:       f.content || '',
          vector,
          namespace:  f.namespace || 'default',
          importance: parseFloat(f.importance || '0.6'),
          tags:       f.tags || '',
          created_at: parseInt(f.created_at || '0'),
        }, 'redis');
      });

      console.log(`[redis] extracted ${records.length} records via RediSearch`);
    } catch (e) {
      console.log(`[redis] RediSearch unavailable (${e.message}) — falling back to SCAN`);
      const keys = [];
      for await (const key of client.scanIterator({ MATCH: `${index}:*`, COUNT: 100 })) {
        keys.push(key);
      }
      for (const key of keys.slice(0, limit)) {
        const hash = await client.hGetAll(key);
        if (!hash.content) continue;
        if (ns && hash.namespace !== ns) continue;
        records.push(toRecord({
          id:         key.replace(`${index}:`, ''),
          text:       hash.content,
          vector:     null,
          namespace:  hash.namespace || 'default',
          importance: parseFloat(hash.importance || '0.6'),
          tags:       hash.tags || '',
          created_at: parseInt(hash.created_at || '0'),
        }, 'redis'));
      }
      console.log(`[redis] extracted ${records.length} records via SCAN`);
    }

    await client.disconnect();
    return records;
  },

  async load(records, opts) {
    const client    = getClient(opts);
    await client.connect();

    const index     = opts.index || DEFAULT_INDEX;
    const batchSize = parseInt(opts['batch-size'] || '100');
    let   upserted  = 0;
    let   hasVSS    = false;

    try {
      await client.ft.info(index);
      hasVSS = true;
    } catch {
      try {
        await client.ft.create(index, {
          id:         { type: 'TEXT',    SORTABLE: true },
          content:    { type: 'TEXT' },
          namespace:  { type: 'TAG',     SORTABLE: true },
          importance: { type: 'NUMERIC', SORTABLE: true },
          tags:       { type: 'TAG' },
          created_at: { type: 'NUMERIC', SORTABLE: true },
          vector: {
            type:            'VECTOR',
            ALGORITHM:       'HNSW',
            TYPE:            'FLOAT32',
            DIM:             VECTOR_DIM,
            DISTANCE_METRIC: 'COSINE',
          },
        }, { ON: 'HASH', PREFIX: `${index}:` });
        hasVSS = true;
        console.log(`[redis] created RediSearch index: ${index}`);
      } catch (e) {
        console.log(`[redis] RediSearch not available — storing as plain hashes (${e.message})`);
      }
    }

    for (let i = 0; i < records.length; i += batchSize) {
      const batch    = records.slice(i, i + batchSize);
      const pipeline = client.multi();

      for (const r of batch) {
        const key  = `${index}:${r.id}`;
        const hash = {
          id:         r.id,
          content:    r.text || '',
          namespace:  r.namespace || 'default',
          importance: String(r.metadata?.importance || 0.6),
          tags:       Array.isArray(r.metadata?.tags)
                        ? r.metadata.tags.join(',')
                        : (r.metadata?.tags || ''),
          created_at: String(r.created_at || Math.floor(Date.now() / 1000)),
          source:     r.source || 'vex',
        };

        if (r.vector && r.vector.length && hasVSS) {
          const buf = Buffer.allocUnsafe(r.vector.length * 4);
          r.vector.forEach((v, j) => buf.writeFloatLE(v, j * 4));
          hash.vector = buf.toString('base64');
        }

        pipeline.hSet(key, hash);
        upserted++;
      }

      await pipeline.exec();
      process.stdout.write(`\r[redis] ${Math.min(i + batchSize, records.length)}/${records.length}`);
    }

    process.stdout.write('\n');
    await client.disconnect();
    console.log(`[redis] wrote ${upserted} records to index "${index}" (VSS: ${hasVSS ? 'yes' : 'no'})`);
    return { upserted, skipped: 0 };
  },
};
