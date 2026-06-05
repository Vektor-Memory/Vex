// core/graph-builder.js
// Post-import MAGMA graph builder for vex load() pipeline.
// Generates temporal + causal + tag edges for imported memory rows
// and writes them to graph_edges in the target DB.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

/**
 * Build graph edges for a set of imported memory rows.
 * @param {object} db        — better-sqlite3 instance (writable)
 * @param {Array}  rows      — imported rows [{id, created_at, tags, namespace, agent_id}]
 * @param {object} opts
 *   opts.agentId            — agent_id scope (default 'vektor-mcp')
 *   opts.temporalWindow     — max seconds between nodes to create temporal edge (default 3600)
 *   opts.batchSize          — rows per progress tick (default 500)
 */
export async function buildGraph(db, rows, opts = {}) {
  const agentId       = opts.agentId ?? 'vektor-mcp';
  const temporalWin   = opts.temporalWindow ?? 3600;
  const batchSize     = opts.batchSize ?? 500;

  // Ensure graph_edges table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_edges (
      id         TEXT PRIMARY KEY,
      source_id  TEXT NOT NULL,
      target_id  TEXT NOT NULL,
      edge_type  TEXT NOT NULL,
      weight     REAL DEFAULT 1.0,
      created_at INTEGER
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS ge_source ON graph_edges(source_id)');
  db.exec('CREATE INDEX IF NOT EXISTS ge_target ON graph_edges(target_id)');

  const insertEdge = db.prepare(`
    INSERT OR IGNORE INTO graph_edges (id, source_id, target_id, edge_type, weight, created_at)
    VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
  `);

  // Sort rows by created_at ascending for temporal chaining
  const sorted = [...rows]
    .filter(r => r.id)
    .sort((a, b) => {
      const ta = toTs(a.created_at);
      const tb = toTs(b.created_at);
      return ta - tb;
    });

  let temporalCount = 0;
  let tagCount = 0;
  let supersededCount = 0;

  const insertMany = db.transaction((edges) => {
    for (const e of edges) insertEdge.run(e.id, e.src, e.tgt, e.type, e.weight);
  });

  // ── Temporal edges: chain consecutive nodes within window ──────────────────
  const temporalEdges = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const tPrev = toTs(prev.created_at);
    const tCurr = toTs(curr.created_at);
    const gap = tCurr - tPrev;
    if (gap >= 0 && gap <= temporalWin) {
      temporalEdges.push({
        id: `ge-temporal-${prev.id}-${curr.id}`.slice(0, 120),
        src: curr.id,
        tgt: prev.id,
        type: 'temporal',
        weight: Math.max(0.1, 1 - gap / temporalWin)
      });
      temporalCount++;
    }
    if (temporalEdges.length >= batchSize) {
      insertMany(temporalEdges.splice(0));
    }
  }
  if (temporalEdges.length) insertMany(temporalEdges);

  // ── Tag edges: connect nodes sharing a tag ─────────────────────────────────
  const tagMap = new Map(); // tag → [id, ...]
  for (const r of sorted) {
    const tags = parseTags(r.tags);
    for (const tag of tags) {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag).push(r.id);
    }
  }
  const tagEdges = [];
  for (const [tag, ids] of tagMap) {
    // Only create edges for tags with 2-50 members (avoid giant hairballs)
    if (ids.length < 2 || ids.length > 50) continue;
    for (let i = 0; i < ids.length - 1; i++) {
      tagEdges.push({
        id: `ge-tag-${tag}-${ids[i]}-${ids[i+1]}`.slice(0, 120),
        src: ids[i],
        tgt: ids[i + 1],
        type: `tag:${tag}`,
        weight: 0.6
      });
      tagCount++;
    }
    if (tagEdges.length >= batchSize) insertMany(tagEdges.splice(0));
  }
  if (tagEdges.length) insertMany(tagEdges);

  // ── Supersession edges: content contains "superseded by <id>" ─────────────
  const supPattern = /superseded[_\s]by[:\s]+([\w-]+)/i;
  const supEdges = [];
  for (const r of sorted) {
    const text = r.content ?? r.text ?? '';
    const m = text.match(supPattern);
    if (m) {
      supEdges.push({
        id: `ge-sup-${r.id}`.slice(0, 120),
        src: r.id,
        tgt: m[1],
        type: 'causal',
        weight: 0.9
      });
      supersededCount++;
    }
    if (supEdges.length >= batchSize) insertMany(supEdges.splice(0));
  }
  if (supEdges.length) insertMany(supEdges);

  return { temporalCount, tagCount, supersededCount, total: temporalCount + tagCount + supersededCount };
}

function toTs(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val < 2e10 ? val : val / 1000;
  const d = new Date(val);
  return isNaN(d) ? 0 : d.getTime() / 1000;
}

function parseTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map(String).filter(Boolean);
  try { const p = JSON.parse(tags); return Array.isArray(p) ? p.map(String).filter(Boolean) : []; }
  catch { return String(tags).split(',').map(s => s.trim()).filter(Boolean); }
}
