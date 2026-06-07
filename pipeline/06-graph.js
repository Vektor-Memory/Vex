/**
 * pipeline/06-graph.js — entity extraction and graph edge building
 * Connects facts that share entities, are from the same conversation,
 * or are temporally adjacent. Works with any SQLite-backed connector.
 * No external dependencies.
 */

// Extract named entities from fact text (simple rule-based, no NLP)
function extractEntities(text) {
  const entities = new Set();

  // Capitalised words/phrases (likely proper nouns)
  const capPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g;
  for (const m of text.matchAll(capPattern)) {
    const e = m[1].trim();
    if (e.length > 2 && !STOPWORDS.has(e.toLowerCase())) entities.add(e);
  }

  // Tech patterns: URLs, package names, version strings
  for (const m of text.matchAll(/\b(vektor[\w-]*|vex|cloak[\w-]*|v\d+\.\d+\.?\d*|npm|sqlite|groq|ollama)\b/gi)) {
    entities.add(m[1]);
  }

  // File paths
  for (const m of text.matchAll(/[\w-]+\.(?:js|mjs|ts|json|md|py|sql|html|css)\b/g)) {
    entities.add(m[0]);
  }

  return [...entities].slice(0, 8); // cap at 8 per fact
}

const STOPWORDS = new Set(['The','This','That','These','Those','They','What','When','Where','Which','Who','How','Why','And','But','For','With','From','Into','After','Before','About','Also','More','Some','Such','Then','Than','Just','Each','Both','Few','Has','Have','Had','Was','Were','Are','Our','Your','Their','Its','His','Her']);

export function buildEdgesFromFacts(facts) {
  const edges = [];

  // Entity-based edges: facts sharing the same entity
  const entityMap = new Map(); // entity -> [fact indices]
  facts.forEach((f, i) => {
    const entities = [...(f.entities || []), ...extractEntities(f.fact)];
    for (const e of entities) {
      const key = e.toLowerCase();
      if (!entityMap.has(key)) entityMap.set(key, []);
      entityMap.get(key).push(i);
    }
  });

  const seen = new Set();
  for (const [entity, indices] of entityMap) {
    if (indices.length < 2) continue;
    for (let i = 0; i < indices.length; i++) {
      for (let j = i + 1; j < Math.min(i + 5, indices.length); j++) {
        const key = indices[i] + ':' + indices[j];
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: facts[indices[i]].id,
          target: facts[indices[j]].id,
          type: 'entity',
          weight: 0.7,
          label: entity,
        });
      }
    }
  }

  // Conversation-based edges: facts from the same conversation
  const convMap = new Map();
  facts.forEach((f, i) => {
    const key = f.sourceConvId || f.convId;
    if (!key) return;
    if (!convMap.has(key)) convMap.set(key, []);
    convMap.get(key).push(i);
  });

  for (const [, indices] of convMap) {
    if (indices.length < 2) continue;
    // Chain: each fact connects to the next from the same conversation
    for (let i = 0; i < indices.length - 1; i++) {
      const key = indices[i] + ':' + indices[i+1];
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: facts[indices[i]].id,
        target: facts[indices[i+1]].id,
        type: 'temporal',
        weight: 0.5,
        label: 'same-conversation',
      });
    }
  }

  return edges;
}

export function writeEdgesToDb(db, edges, agentId = 'default') {
  if (!edges.length) return 0;

  // Try different edge table schemas gracefully
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);

  let written = 0;

  if (tables.includes('graph_edges')) {
    let stmt;
    try {
      stmt = db.prepare(`INSERT OR IGNORE INTO graph_edges (source_id,target_id,relation,weight,agent_id) VALUES (?,?,?,?,?)`);
    } catch {
      try {
        stmt = db.prepare(`INSERT OR IGNORE INTO graph_edges (from_id,to_id,edge_type,weight,agent_id) VALUES (?,?,?,?,?)`);
      } catch { stmt = null; }
    }
    if (stmt) {
      const batch = db.transaction(edges => { for (const e of edges) { try { stmt.run(e.source,e.target,e.type,e.weight,agentId); written++; } catch {} } });
      batch(edges);
    }
  }

  if (tables.includes('memory_edges')) {
    try {
      const stmt = db.prepare(`INSERT OR IGNORE INTO memory_edges (agent_id,source_id,target_id,edge_type,weight) VALUES (?,?,?,?,?)`);
      const batch = db.transaction(edges => { for (const e of edges) { try { stmt.run(agentId,e.source,e.target,e.type,e.weight); written++; } catch {} } });
      batch(edges);
    } catch {}
  }

  process.stdout.write(`[graph] wrote ${written} edges (${edges.length} total)\n`);
  return written;
}
