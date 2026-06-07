/**
 * connectors/pgvector.js — PostgreSQL + pgvector extension
 * Requires: pg (npm install pg)
 * pgvector extension must be installed: CREATE EXTENSION IF NOT EXISTS vector;
 *
 * Usage:
 *   vex migrate --from vektor --to pgvector --url postgres://user:pass@localhost:5432/mydb
 *   vex migrate --from vektor --to pgvector --url postgres://user:pass@localhost:5432/mydb --table vex_memories
 *
 * Supabase:
 *   vex migrate ... --url postgresql://postgres:[password]@db.[ref].supabase.co:5432/postgres
 *
 * Table schema (auto-created):
 *   id TEXT PRIMARY KEY
 *   content TEXT
 *   namespace TEXT
 *   importance FLOAT
 *   tags TEXT
 *   entities TEXT
 *   potential TEXT
 *   created_at BIGINT
 *   source TEXT
 *   vector vector(1536)   -- or detected dim
 *   metadata JSONB
 */

import { toRecord } from '../formats/vmig.js';
import { createRequire } from 'module';

const require        = createRequire(import.meta.url);
const DEFAULT_TABLE  = 'vex_memories';
const BATCH_SIZE     = 100;

function getPool(opts) {
  try {
    const { Pool } = require('pg');
    const url = opts.url || opts['pg-url'] || process.env.PGVECTOR_URL || process.env.DATABASE_URL;
    if (!url) throw new Error('--url <postgres://...> required');
    return new Pool({ connectionString: url });
  } catch (e) {
    if (e.message.includes('pg package')) throw e;
    throw new Error('pg package not found — run: npm install pg');
  }
}

async function ensureTable(client, table, dim) {
  // Enable pgvector extension
  await client.query('CREATE EXTENSION IF NOT EXISTS vector');

  // Create table
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id          TEXT PRIMARY KEY,
      content     TEXT,
      namespace   TEXT DEFAULT 'default',
      importance  FLOAT DEFAULT 0.6,
      tags        TEXT,
      entities    TEXT,
      potential   TEXT,
      created_at  BIGINT,
      source      TEXT,
      metadata    JSONB,
      vector      vector(${dim})
    )
  `);

  // Indexes
  await client.query(`CREATE INDEX IF NOT EXISTS ${table}_ns_idx ON ${table} (namespace)`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${table}_imp_idx ON ${table} (importance DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${table}_ts_idx ON ${table} (created_at DESC)`);

  // IVFFlat vector index -- only useful at scale (>1000 rows)
  // Using HNSW for better recall (requires pgvector >= 0.5.0)
  try {
    await client.query(`
      CREATE INDEX IF NOT EXISTS ${table}_vec_idx
      ON ${table} USING hnsw (vector vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
    `);
  } catch {
    // Fall back to IVFFlat if HNSW not available
    try {
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${table}_vec_idx
        ON ${table} USING ivfflat (vector vector_cosine_ops)
        WITH (lists = 100)
      `);
    } catch {
      console.log(`[pgvector] vector index skipped -- needs more rows or older pgvector`);
    }
  }

  console.log(`[pgvector] table "${table}" ready (dim=${dim})`);
}

export const pgvectorConnector = {
  name: 'pgvector',

  async extract(opts) {
    const pool    = getPool(opts);
    const client  = await pool.connect();
    const table   = opts.table || DEFAULT_TABLE;
    const ns      = opts.namespace;
    const limit   = parseInt(opts.limit || '10000');

    try {
      const query = ns
        ? `SELECT * FROM ${table} WHERE namespace = $1 ORDER BY created_at DESC LIMIT $2`
        : `SELECT * FROM ${table} ORDER BY created_at DESC LIMIT $1`;
      const params = ns ? [ns, limit] : [limit];
      const res    = await client.query(query, params);

      const records = res.rows.map(row => toRecord({
        id:         row.id,
        text:       row.content || '',
        vector:     row.vector  ? JSON.parse(row.vector) : null,
        namespace:  row.namespace || 'default',
        importance: row.importance || 0.6,
        tags:       row.tags || '',
        created_at: Number(row.created_at || 0),
      }, 'pgvector'));

      console.log(`[pgvector] extracted ${records.length} rows from "${table}"`);
      return records;
    } finally {
      client.release();
      await pool.end();
    }
  },

  async load(records, opts) {
    const pool   = getPool(opts);
    const client = await pool.connect();
    const table  = opts.table || DEFAULT_TABLE;

    // Detect vector dim
    const sample = records.find(r => r.vector && r.vector.length);
    const dim    = sample ? sample.vector.length : 1536;

    try {
      await ensureTable(client, table, dim);

      let upserted = 0;
      let skipped  = 0;

      for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = records.slice(i, i + BATCH_SIZE);

        for (const r of batch) {
          try {
            const tags      = Array.isArray(r.metadata?.tags) ? r.metadata.tags.join(',') : (r.metadata?.tags || '');
            const entities  = Array.isArray(r.metadata?.entities) ? r.metadata.entities.join(',') : '';
            const potential = Array.isArray(r.metadata?.potential) ? r.metadata.potential.join('|||') : '';
            const vector    = r.vector && r.vector.length === dim
                                ? `[${r.vector.join(',')}]`
                                : null;

            await client.query(`
              INSERT INTO ${table}
                (id, content, namespace, importance, tags, entities, potential, created_at, source, metadata, vector)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector)
              ON CONFLICT (id) DO UPDATE SET
                content    = EXCLUDED.content,
                namespace  = EXCLUDED.namespace,
                importance = EXCLUDED.importance,
                tags       = EXCLUDED.tags,
                entities   = EXCLUDED.entities,
                potential  = EXCLUDED.potential,
                source     = EXCLUDED.source,
                metadata   = EXCLUDED.metadata,
                vector     = EXCLUDED.vector
            `, [
              String(r.id),
              r.text || '',
              r.namespace || 'default',
              r.metadata?.importance || 0.6,
              tags,
              entities,
              potential,
              r.created_at || Math.floor(Date.now() / 1000),
              r.source || 'vex',
              JSON.stringify(r.metadata || {}),
              vector,
            ]);

            upserted++;
          } catch (e) {
            console.error(`\n[pgvector] row error (${r.id}): ${e.message}`);
            skipped++;
          }
        }

        process.stdout.write(`\r[pgvector] ${Math.min(i + BATCH_SIZE, records.length)}/${records.length}`);
      }

      process.stdout.write('\n');
      console.log(`[pgvector] wrote ${upserted} rows to "${table}" (${skipped} failed)`);
      return { upserted, skipped };
    } finally {
      client.release();
      await pool.end();
    }
  },
};
