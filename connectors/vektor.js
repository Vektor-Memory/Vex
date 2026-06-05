import { createRequire } from 'module';
import { toRecord }   from '../formats/vmig.js';
import { progress, summary } from '../utils/progress.js';

// ── Lazy loader ───────────────────────────────────────────────────────────────

let _Database = null;
async function getDatabase() {
  if (_Database) return _Database;
  try {
    const mod  = await import('better-sqlite3');
    _Database  = mod.default;
    return _Database;
  } catch {
    throw new Error(
      'better-sqlite3 is required for the vektor connector.\n' +
      '  Install: npm install better-sqlite3\n' +
      '  Node 24+: npm install better-sqlite3 --build-from-source'
    );
  }
}

// ── sqlite-vec helpers ────────────────────────────────────────────────────────

const _require = createRequire(import.meta.url);

function loadSqliteVec(db) {
  try {
    const sqliteVec = _require('sqlite-vec');
    sqliteVec.load(db);
    return true;
  } catch {
    return false;
  }
}

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
    const queryVecRaw = opts['vec-query'] || null;

    const Database = await getDatabase();
    const normPath = dbPath.replace(/\\/g, '/');
    const db     = new Database(normPath, { readonly: true });
    const hasVec = loadSqliteVec(db) && vecAvailable(db);

    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
      console.log(`[vektor] tables: ${tables.join(', ')}`);
      if (tables.includes('memories')) {
        const cnt = db.prepare('SELECT COUNT(*) as n FROM memories').get();
        console.log(`[vektor] memories count: ${cnt.n}`);
      } else {
        throw new Error('[vektor] "memories" table not found in DB. Available: ' + tables.join(', '));
      }
    } catch (e) {
      if (e.message.includes('memories')) throw e;
    }

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

    if (queryVecRaw && !hasVec) {
      console.warn('[vektor] --vec-query ignored: memories_vec not available. Run scripts/migrate-vec.mjs first.');
    }

    const colInfo  = db.prepare('PRAGMA table_info(memories)').all();
    const colNames = colInfo.map(c => c.name);

    const vecCol  = colNames.includes('embedding') ? 'embedding'
                  : colNames.includes('vector')    ? 'vector'
                  : null;
    if (!vecCol) throw new Error('[vektor] memories table has no embedding or vector column');

    const hasMeta      = colNames.includes('metadata');
    const hasNs        = colNames.includes('namespace');
    const hasCreatedAt = colNames.includes('created_at');
    const hasImportance= colNames.includes('importance');
    const hasTags      = colNames.includes('tags');

    const selectCols = [
      'id',
      'content AS text',
      `${vecCol} AS vector`,
      hasMeta       ? 'metadata'   : 'NULL AS metadata',
      hasNs         ? 'namespace'  : 'NULL AS namespace',
      hasCreatedAt  ? 'created_at' : 'NULL AS created_at',
      hasImportance ? 'importance' : 'NULL AS importance',
      hasTags       ? 'tags'       : 'NULL AS tags',
    ].join(', ');

    let sql = `SELECT ${selectCols} FROM memories`;
    const params = [];
    if (namespace && hasNs) { sql += ` WHERE namespace = ?`; params.push(namespace); }
    sql += ` ORDER BY ${hasCreatedAt ? 'created_at' : 'id'} DESC`;
    if (limit) { sql += ` LIMIT ?`; params.push(limit); }

    const rows = db.prepare(sql).all(...params);
    db.close();

    return rows.map(row => {
      let meta = null;
      try { meta = row.metadata ? JSON.parse(row.metadata) : null; } catch {}
      if (row.importance != null || row.tags) {
        meta = meta || {};
        if (row.importance != null) meta.importance = row.importance;
        if (row.tags)               meta.tags       = row.tags;
      }
      return toRecord({ ...row, vector: blobToVector(row.vector), metadata: meta }, 'vektor');
    });
  },

  // ── IMPORT ──────────────────────────────────────────────────────────────────
  async load(records, opts) {
    const t0     = Date.now();
    const dbPath = opts['db'] || opts['path'] || 'slipstream-memory.db';

    const Database = await getDatabase();
    const db = new Database(dbPath);

    // Detect existing schema — works with both minimal and full VEKTOR schemas
    const colInfo  = db.prepare('PRAGMA table_info(memories)').all();
    const colNames = colInfo.map(c => c.name);
    const idIsInt  = (colInfo.find(c => c.name === 'id')?.type || '').toUpperCase().includes('INT');

    const vecCol   = colNames.includes('embedding') ? 'embedding'
                   : colNames.includes('vector')    ? 'vector'
                   : 'embedding';

    const hasMeta      = colNames.includes('metadata');
    const hasNs        = colNames.includes('namespace');
    const hasCreatedAt = colNames.includes('created_at');
    const hasImportance= colNames.includes('importance');
    const hasTags      = colNames.includes('tags');
    const hasMemType   = colNames.includes('memory_type');

    // Only create the table if it doesn't already exist
    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memories'"
    ).get();
    if (!tableExists) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS memories (` +
        `id TEXT PRIMARY KEY, content TEXT, ${vecCol} BLOB, ` +
        `metadata TEXT, created_at TEXT, namespace TEXT)`
      );
    }

    // sqlite-vec — best effort, non-fatal if unavailable
    const hasVec = loadSqliteVec(db) && vecAvailable(db);
    if (hasVec) console.log('[vektor] sqlite-vec available — will sync memories_vec on import');
    // Suspend FTS triggers that use TEXT id as rowid (causes datatype mismatch)
    const ftsTriggers = db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='memories' AND sql LIKE '%memories_fts%'"
    ).all();
    for (const t of ftsTriggers) db.exec(`DROP TRIGGER IF EXISTS "${t.name}"`);


    // Build INSERT dynamically from columns that actually exist in this DB
    const insertCols = ['content', vecCol];
    if (!idIsInt)      insertCols.unshift('id');
    if (hasMeta)       insertCols.push('metadata');
    if (hasNs)         insertCols.push('namespace');
    if (hasCreatedAt)  insertCols.push('created_at');
    if (hasImportance) insertCols.push('importance');
    if (hasTags)       insertCols.push('tags');
    if (hasMemType)    insertCols.push('memory_type');

    const placeholders = insertCols.map(c => c === vecCol ? '@vec' : '@' + c).join(', ');
    const insert = db.prepare(
      `INSERT INTO memories (${insertCols.join(', ')}) VALUES (${placeholders})`
    );

    const insertVec = hasVec
      ? db.prepare(
          `INSERT OR REPLACE INTO memories_vec(rowid, embedding) ` +
          `VALUES ((SELECT rowid FROM memories WHERE id = ?), ?)`
        )
      : null;

    let upserted = 0, skipped = 0, vecSynced = 0;

    const insertMany = db.transaction(batch => {
      for (const r of batch) {
        try {
          const embBlob = vectorToBlob(r.vector);
          const meta    = r.metadata || {};
          const row = {
            content:     r.text || null,
            vec:         embBlob,
            namespace:   r.namespace   || 'claude-conversations',
            created_at:  r.created_at ? (typeof r.created_at === 'string' ? Math.floor(new Date(r.created_at).getTime()/1000) : r.created_at) : Math.floor(Date.now()/1000),
            metadata:    r.metadata    ? JSON.stringify(r.metadata) : null,
            importance:  typeof meta.importance === 'number' ? meta.importance : 1.0,
            tags:        meta.tags     || '',
            memory_type: meta.memory_type || 'episodic',
          };
          if (!idIsInt) row.id = String(r.id);
          insert.run(row);
          upserted++;
          if (insertVec && embBlob) {
            try { insertVec.run(String(r.id), embBlob); vecSynced++; } catch {}
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


    // Rebuild FTS index and restore triggers
    try {
      if (ftsTriggers.length) {
        db.exec('INSERT INTO memories_fts(memories_fts) VALUES(\'rebuild\')');
        for (const t of ftsTriggers) db.exec(t.sql);
        console.log(`[vektor] FTS rebuilt, ${ftsTriggers.length} trigger(s) restored`);
      }
    } catch (e) { console.warn('[vektor] FTS rebuild warning:', e.message); }
    db.close();
    if (hasVec) console.log(`[vektor] memories_vec synced: ${vecSynced}/${upserted}`);
    summary({ connector: 'vektor', total: records.length, upserted, skipped, durationMs: Date.now() - t0 });
    console.log(`[vektor] written to ${dbPath}`);
    return { upserted, skipped };
  },

  // ── STREAMING EXPORT ────────────────────────────────────────────────────────
  async extractStream(opts, onPage) {
    const records = await this.extract(opts);
    const PAGE    = 1000;
    for (let i = 0; i < records.length; i += PAGE) {
      await onPage(records.slice(i, i + PAGE));
    }
  },

  // ── DIM DETECTION ───────────────────────────────────────────────────────────
  async getDims(opts) {
    const dbPath = opts['db'] || opts['path'] || 'slipstream-memory.db';
    try {
      const Database = await getDatabase();
      const db  = new Database(dbPath, { readonly: true });
      const colInfo2 = db.prepare('PRAGMA table_info(memories)').all();
      const vcol     = colInfo2.map(c => c.name).includes('embedding') ? 'embedding' : 'vector';
      const row = db.prepare(
        `SELECT ${vcol} AS vec FROM memories WHERE ${vcol} IS NOT NULL LIMIT 1`
      ).get();
      db.close();
      if (!row?.vec) return null;
      const buf = Buffer.isBuffer(row.vec) ? row.vec : Buffer.from(row.vec);
      return buf.byteLength / 4;
    } catch {
      return null;
    }
  },
};
