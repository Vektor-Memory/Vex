import Database       from 'better-sqlite3';
import { createRequire } from 'module';
import { toRecord }   from '../formats/vmig.js';
import { progress, summary } from '../utils/progress.js';

// ── sqlite-vec helpers ────────────────────────────────────────────────────────

const _require = createRequire(import.meta.url);

/**
 * Load sqlite-vec extension into a better-sqlite3 db instance.
 * Returns true if loaded, false if unavailable (non-fatal).
 */
function loadSqliteVec(db) {
  try {
    const sqliteVec = _require('sqlite-vec');
    sqliteVec.load(db);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check memories_vec exists and is queryable.
 */
function vecAvailable(db) {
  try {
    const row = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='memories_vec'`
    ).get();
    if (!row) return false;
    db.prepare(`SELECT rowid FROM memories_vec LIMIT 0`).all();
    return true;
  } catch {
    return false;
  }
}

/**
 * Deserialise a stored embedding BLOB → JS number array.
 * Returns null on any error.
 */
function blobToVector(blob) {
  try {
    if (!blob) return null;
    const buf    = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
    const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    return Array.from(floats);
  } catch {
    return null;
  }
}

/**
 * Serialise a JS number array → Float32 Buffer for storage.
 * Returns null if input invalid.
 */
function vectorToBlob(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return Buffer.from(new Float32Array(arr).buffer);
}

// ── connector ─────────────────────────────────────────────────────────────────

export const vektorConnector = {
  name: 'vektor',

  // ── EXPORT ──────────────────────────────────────────────────────────────────
  async extract(opts) {
    const dbPath      = opts['db']        || opts['path'] || 'slipstream-memory.db';
    const namespace   = opts['namespace'] || null;
    const limit       = opts['limit']     ? parseInt(opts['limit']) : null;
    const queryVecRaw = opts['vec-query'] || null; // JSON float array → ANN export

    const db     = new Database(dbPath, { readonly: true });
    const hasVec = loadSqliteVec(db) && vecAvailable(db);

    // ── ANN-ordered export via sqlite-vec ──────────────────────────────────
    if (queryVecRaw && hasVec) {
      let queryArr;
      try {
        queryArr = JSON.parse(queryVecRaw);
        if (!Array.isArray(queryArr)) throw new Error('not an array');
      } catch (e) {
        db.close();
        throw new Error(`[vektor] --vec-query must be a JSON float array: ${e.message}`);
      }

      const k   = limit || 100;
      const f32 = new Float32Array(queryArr);
      console.log(`[vektor] ANN export via sqlite-vec (k=${k}, dims=${queryArr.length})`);

      let sql = `
        SELECT m.id, m.content AS text, m.embedding AS vector,
               m.metadata, m.created_at, m.namespace,
               v.distance AS vec_score
        FROM memories_vec v
        JOIN memories m ON m.rowid = v.rowid
        WHERE v.embedding MATCH ?
          AND k = ?
      `;
      const params = [Buffer.from(f32.buffer), k];
      if (namespace) { sql += ` AND m.namespace = ?`; params.push(namespace); }

      const rows = db.prepare(sql).all(...params);
      db.close();

      return rows.map(row => {
        let meta = null;
        try { meta = row.metadata ? JSON.parse(row.metadata) : null; } catch {}
        return toRecord({
          ...row,
          vector:   blobToVector(row.vector),
          metadata: { ...meta, vec_score: row.vec_score },
        }, 'vektor');
      });
    }

    // ── Standard export (existing behaviour) ──────────────────────────────
    if (queryVecRaw && !hasVec) {
      console.warn('[vektor] --vec-query ignored: memories_vec not available. Run scripts/migrate-vec.mjs first.');
    }

    let sql = `
      SELECT id, content AS text, embedding AS vector, metadata, created_at, namespace
      FROM memories
    `;
    const params = [];
    if (namespace) { sql += ` WHERE namespace = ?`; params.push(namespace); }
    sql += ` ORDER BY created_at DESC`;
    if (limit) { sql += ` LIMIT ?`; params.push(limit); }

    const rows = db.prepare(sql).all(...params);
    db.close();

    return rows.map(row => {
      let meta = null;
      try { meta = row.metadata ? JSON.parse(row.metadata) : null; } catch {}
      return toRecord({ ...row, vector: blobToVector(row.vector), metadata: meta }, 'vektor');
    });
  },

  // ── IMPORT ──────────────────────────────────────────────────────────────────
  async load(records, opts) {
    const t0     = Date.now();
    const dbPath = opts['db'] || opts['path'] || 'slipstream-memory.db';

    const db = new Database(dbPath);

    // ensure base table exists (same schema as VEKTOR Slipstream)
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id         TEXT PRIMARY KEY,
        content    TEXT,
        embedding  BLOB,
        metadata   TEXT,
        created_at TEXT,
        namespace  TEXT
      )
    `);

    // sqlite-vec — best effort, non-fatal if unavailable or not migrated
    const hasVec = loadSqliteVec(db) && vecAvailable(db);
    if (hasVec) {
      console.log('[vektor] sqlite-vec available — will sync memories_vec on import');
    }

    const insert = db.prepare(`
      INSERT OR REPLACE INTO memories (id, content, embedding, metadata, created_at, namespace)
      VALUES (@id, @content, @embedding, @metadata, @created_at, @namespace)
    `);

    // Use subquery to get rowid after insert (vec0 needs rowid, not TEXT id)
    const insertVec = hasVec
      ? db.prepare(`
          INSERT OR REPLACE INTO memories_vec(rowid, embedding)
          VALUES ((SELECT rowid FROM memories WHERE id = ?), ?)
        `)
      : null;

    let upserted = 0;
    let skipped  = 0;
    let vecSynced = 0;

    const insertMany = db.transaction(batch => {
      for (const r of batch) {
        try {
          const embBlob = vectorToBlob(r.vector);

          insert.run({
            id:         String(r.id),
            content:    r.text        || null,
            embedding:  embBlob,
            metadata:   r.metadata    ? JSON.stringify(r.metadata) : null,
            created_at: r.created_at  || new Date().toISOString(),
            namespace:  r.namespace   || null,
          });
          upserted++;

          // sync to memories_vec — non-fatal
          if (insertVec && embBlob) {
            try {
              insertVec.run(String(r.id), embBlob);
              vecSynced++;
            } catch { /* dim mismatch or other — skip silently */ }
          }
        } catch (e) {
          skipped++;
          console.warn(`[vektor] skipping id=${r.id}: ${e.message}`);
        }
      }
    });

    const BATCH = 500;
    for (let i = 0; i < records.length; i += BATCH) {
      insertMany(records.slice(i, i + BATCH));
      progress(Math.min(i + BATCH, records.length), records.length, 'vektor import');
    }

    db.close();

    if (hasVec) {
      console.log(`[vektor] memories_vec synced: ${vecSynced}/${upserted}`);
    }
    summary({ connector: 'vektor', total: records.length, upserted, skipped, durationMs: Date.now() - t0 });
    console.log(`[vektor] written to ${dbPath}`);
  },

  // ── STREAMING EXPORT ────────────────────────────────────────────────────────
  async extractStream(opts, onPage) {
    // SQLite reads are local + fast — load all then page.
    // For vec-query ANN path this is fine since k is bounded.
    const records = await this.extract(opts);
    const PAGE    = 1000;
    for (let i = 0; i < records.length; i += PAGE) {
      await onPage(records.slice(i, i + PAGE));
    }
  },

  // ── DIM DETECTION ───────────────────────────────────────────────────────────
  // Used by core/migrate.js dimCheck to detect source vector dimensions.
  async getDims(opts) {
    const dbPath = opts['db'] || opts['path'] || 'slipstream-memory.db';
    try {
      const db  = new Database(dbPath, { readonly: true });
      const row = db.prepare(
        `SELECT embedding FROM memories WHERE embedding IS NOT NULL LIMIT 1`
      ).get();
      db.close();
      if (!row?.embedding) return null;
      const buf = Buffer.isBuffer(row.embedding) ? row.embedding : Buffer.from(row.embedding);
      return buf.byteLength / 4; // Float32 = 4 bytes each
    } catch {
      return null;
    }
  },
};
