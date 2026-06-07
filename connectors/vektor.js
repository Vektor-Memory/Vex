import { toRecord } from '../formats/vmig.js';
import { buildGraph } from '../core/graph-builder.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Resolve better-sqlite3 — try vektor-slipstream bundled first, then global
function getSqlite() {
  const candidates = [
    process.env.VEKTOR_DB_PATH && require('path').join(
      require('path').dirname(process.env.VEKTOR_DB_PATH || ''),
      '../../AppData/Local/nvm/v24.1.0/node_modules/vektor-slipstream/bundled/better-sqlite3'
    ),
    require('path').join(process.env.APPDATA || '', '../Local/nvm/v24.1.0/node_modules/vektor-slipstream/bundled/better-sqlite3'),
    'better-sqlite3',
  ].filter(Boolean);
  for (const p of candidates) {
    try { return require(p); } catch {}
  }
  throw new Error('better-sqlite3 not found — install vektor-slipstream or better-sqlite3');
}

export const vektorConnector = {
  name: 'vektor',

  async extract(opts) {
    const dbPath = opts.db ?? process.env.VEKTOR_DB;
    if (!dbPath) throw new Error('vektor connector requires --db path or VEKTOR_DB env var');

    const Database = getSqlite();
    const db = new Database(dbPath, { readonly: true });

    const rows = db.prepare(`
      SELECT m.id, m.content as text, m.vector, m.namespace,
             m.agent_id, m.tags, m.importance, m.created_at
      FROM memories m
      ${opts.namespace ? 'WHERE m.namespace = ?' : ''}
      ORDER BY m.created_at DESC
      ${opts.limit ? 'LIMIT ' + parseInt(opts.limit) : ''}
    `).all(...(opts.namespace ? [opts.namespace] : []));

    db.close();
    const records = rows.map(row => {
      let vector = null;
      if (row.vector && row.vector.length > 4) {
        try {
          const buf = Buffer.isBuffer(row.vector) ? row.vector : Buffer.from(row.vector);
          const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
          vector = Array.from(f32);
        } catch {}
      }
      return toRecord({ ...row, text: row.text, vector }, 'vektor');
    });
    console.log(`[vektor] extracted ${records.length} records`);
    return records;
  },

  async load(records, opts) {
    const dbPath = opts.db ?? process.env.VEKTOR_DB_PATH ?? process.env.VEKTOR_DB;
    if (!dbPath) throw new Error('vektor load requires --db path or VEKTOR_DB_PATH env var');

    const agentId   = opts['agent-id'] ?? process.env.VEKTOR_AGENT_ID ?? 'vektor-mcp';
    const namespace = opts.namespace ?? 'default';
    const skipGraph = opts['skip-graph'] === 'true' || opts['skip-graph'] === true;
    const batchSize = parseInt(opts['batch-size'] ?? '500');

    const Database = getSqlite();
    const db = new Database(dbPath);

    // Ensure memories table exists (minimal schema — real schema created by SDK)
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT, agent_id TEXT, content TEXT, summary TEXT, importance INT,
        tags TEXT, namespace TEXT, pinned INT, created_at NUM, updated_at NUM,
        vector BLOB, edge_type TEXT, potential TEXT
      )
    `);

    // Add potential column if missing (older DBs created before this field existed)
    const cols = db.prepare("PRAGMA table_info(memories)").all().map(c => c.name);
    if (!cols.includes('potential')) {
      db.exec("ALTER TABLE memories ADD COLUMN potential TEXT");
    }

    // Temporarily drop FTS trigger to allow TEXT id imports
    const ftsInsertSql = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get("memories_fts_insert")?.sql;
    if(ftsInsertSql) db.exec("DROP TRIGGER IF EXISTS memories_fts_insert");

    const upsert = db.prepare(`
      INSERT OR IGNORE INTO memories
        (id, agent_id, content, namespace, importance, tags, created_at, updated_at, vector, potential)
      VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s','now'), ?, ?)
    `);

    const insertBatch = db.transaction((batch) => {
      for (const r of batch) {
        const id = r.id ?? String(Date.now() * 1000 + Math.floor(Math.random() * 999));
        const content = typeof r.text === 'string' ? r.text :
                        (r.text != null ? JSON.stringify(r.text) : '');
        if (!content.trim()) continue;

        let vectorBlob = null;
        if (Array.isArray(r.vector) && r.vector.length > 0) {
          const f32 = new Float32Array(r.vector);
          vectorBlob = Buffer.from(f32.buffer);
        }

        const tags = r.metadata?.tags
          ? (Array.isArray(r.metadata.tags) ? r.metadata.tags.join(',') : String(r.metadata.tags))
          : null;
        const potential = r.metadata?.potential
          ? (Array.isArray(r.metadata.potential) ? JSON.stringify(r.metadata.potential) : String(r.metadata.potential))
          : null;
        const importance = r.metadata?.importance ?? 3;
        const createdAt = r.created_at
          ? (typeof r.created_at === 'number' ? r.created_at : Math.floor(new Date(r.created_at).getTime() / 1000))
          : Math.floor(Date.now() / 1000);

        upsert.run(id, agentId, content, namespace, importance, tags, createdAt, vectorBlob, potential);
      }
    });

    // Write in batches with progress — count actual new rows inserted
    let written = 0;
    for (let i = 0; i < records.length; i += batchSize) {
      const before = db.prepare('SELECT COUNT(*) as c FROM memories WHERE namespace=?').get(namespace).c;
      insertBatch(records.slice(i, i + batchSize));
      const after  = db.prepare('SELECT COUNT(*) as c FROM memories WHERE namespace=?').get(namespace).c;
      written += (after - before);
      process.stdout.write(`\r[vektor] writing... ${Math.min(i+batchSize,records.length)}/${records.length}`);
    }
    const skippedCount = records.length - written;
    // Restore FTS trigger
    if(ftsInsertSql) db.exec(ftsInsertSql);

    console.log(`\n[vektor] wrote ${written} new records (${skippedCount} skipped/duplicate) → ${dbPath}`);

    // Build graph edges unless skipped
    if (!skipGraph) {
      console.log('[vektor] building graph edges...');
      // Fetch the written rows back for graph building
      const written_rows = db.prepare(
        `SELECT id, content, tags, created_at, agent_id FROM memories WHERE agent_id = ? ORDER BY created_at ASC`
      ).all(agentId);

      const result = await buildGraph(db, written_rows, { agentId, batchSize });
      console.log(`[vektor] graph built — temporal:${result.temporalCount} tag:${result.tagCount} causal:${result.supersededCount} total:${result.total}`);
    }

    db.close();
    return { upserted: written, skipped: skippedCount, dbPath };
  }
};
