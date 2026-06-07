/**
 * pipeline/index.js — full 7-step import pipeline orchestrator
 *
 * Steps:
 *   1. CHUNK        — split conversations into processable units
 *   2. EXTRACT      — LLM fact extraction (--mode extract/smart only)
 *   3. SCORE        — importance + recency scoring
 *   4. DEDUP        — remove near-duplicates within batch
 *   5. EMBED        — optional vectors (OpenAI/Ollama)
 *   6. GRAPH        — entity extraction + edge writing
 *   7. STORE        — write to target connector
 *
 * Modes:
 *   raw     — steps 1,5,6,7 only (fast, current behaviour, blob storage)
 *   extract — all 7 steps (LLM required, atomic facts, full graph)
 *   smart   — all 7 steps, exchange chunking for short convs (recommended)
 *
 * Usage from vex migrate:
 *   vex migrate --from claude-export --to vektor --file convs.json --db mem.db --mode extract --groq-key $KEY
 */

import { chunkConversations }          from './01-chunk.js';
import { extractFacts, resolveProvider } from './02-extract.js';
import { scoreFacts, filterByImportance } from './03-score.js';
import { dedupFacts }                  from './04-dedup.js';
import { embedFacts }                  from './05-embed.js';
import { buildEdgesFromFacts, writeEdgesToDb } from './06-graph.js';
import { storeFacts }                  from './07-store.js';
import { createRequire }               from 'module';

const require = createRequire(import.meta.url);

function getSqlite() {
  for (const p of [
    require('path').join(process.env.APPDATA||'','../Local/nvm/v24.1.0/node_modules/vektor-slipstream/bundled/better-sqlite3'),
    'better-sqlite3',
  ]) {
    try { return require(p); } catch {}
  }
  return null;
}

export async function runPipeline(conversations, connector, opts = {}) {
  const mode    = (opts.mode || 'raw').toLowerCase();
  const dryRun  = opts['dry-run'] || false;
  const minImp  = parseFloat(opts['min-importance'] || '0.5');
  const agentId = opts['agent-id'] || 'default';

  const startTime = Date.now();

  process.stdout.write(`\n[pipeline] mode=${mode} conversations=${conversations.length}${dryRun ? ' DRY-RUN' : ''}\n`);
  process.stdout.write(`[pipeline] ──────────────────────────────────────────────\n`);

  // ── STEP 1: CHUNK ──────────────────────────────────────────────────────────
  process.stdout.write('[pipeline] step 1/7 — chunking\n');
  const chunkMode = mode === 'smart' ? 'smart' : (opts['chunk-mode'] || 'conversation');
  const chunks = chunkConversations(conversations, {
    mode:     chunkMode,
    sender:   opts.sender || 'both',
    maxChars: opts['max-chars'] ? parseInt(opts['max-chars']) : null,
  });
  process.stdout.write(`[pipeline] ${chunks.length} chunks from ${conversations.length} conversations\n`);

  if (mode === 'raw') {
    // Raw mode: skip steps 2-4, go straight to embed + store (original behaviour)
    process.stdout.write('[pipeline] mode=raw — skipping extraction (LLM)\n');

    // Convert chunks to raw records for store
    const rawFacts = chunks.map(c => ({
      id: c.id,
      fact: c.text,
      type: 'conversation',
      importance: 0.6,
      entities: [],
      vector: null,
      created_at: c.created_at,
      sourceConvId: c.convId,
      sourceConvName: c.convName,
    }));

    // Step 5: embed
    process.stdout.write('[pipeline] step 5/7 — embedding (optional)\n');
    const embedded = await embedFacts(rawFacts, opts);

    // Step 6: graph edges
    process.stdout.write('[pipeline] step 6/7 — building graph edges\n');
    const edges = buildEdgesFromFacts(embedded);

    // Step 7: store
    process.stdout.write('[pipeline] step 7/7 — storing\n');
    if (dryRun) {
      process.stdout.write(`[pipeline] DRY RUN — would store ${embedded.length} records\n`);
      return { upserted: 0, skipped: 0, facts: 0, edges: 0, mode, dryRun: true };
    }
    const result = await storeFacts(embedded, connector, opts);

    // Write edges if connector has a DB
    let edgesWritten = 0;
    const dbPath = opts.db || process.env.VEKTOR_DB_PATH || process.env.VEKTOR_DB;
    if (edges.length && dbPath) {
      try {
        const Sqlite = getSqlite();
        if (Sqlite) {
          const db = new Sqlite(dbPath);
          edgesWritten = writeEdgesToDb(db, edges, agentId);
          db.close();
        }
      } catch (e) { process.stderr.write('[pipeline] graph write error: ' + e.message + '\n'); }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    process.stdout.write(`[pipeline] ✓ complete in ${elapsed}s — ${result.upserted} stored, ${edgesWritten} edges\n`);
    return { ...result, facts: embedded.length, edges: edgesWritten, mode };
  }

  // ── STEP 2: EXTRACT (extract/smart modes) ────────────────────────────────
  process.stdout.write('[pipeline] step 2/7 — LLM fact extraction\n');
  const provider = resolveProvider(opts);
  if (!provider) {
    process.stderr.write('[pipeline] ERROR: --mode ' + mode + ' requires an LLM provider.\n');
    process.stderr.write('[pipeline] Add one of: --groq-key, --openai-key, --anthropic-key, --ollama-url\n');
    process.stderr.write('[pipeline] Or use --mode raw to skip extraction.\n');
    throw new Error('LLM provider required for mode=' + mode);
  }

  let facts = await extractFacts(chunks, opts);

  // ── STEP 3: SCORE ────────────────────────────────────────────────────────
  process.stdout.write('[pipeline] step 3/7 — scoring\n');
  facts = scoreFacts(facts);
  facts = filterByImportance(facts, minImp);
  process.stdout.write(`[pipeline] ${facts.length} facts after scoring (min-importance=${minImp})\n`);

  // ── STEP 4: DEDUP ────────────────────────────────────────────────────────
  process.stdout.write('[pipeline] step 4/7 — deduplication\n');
  facts = dedupFacts(facts);

  // ── STEP 5: EMBED ────────────────────────────────────────────────────────
  process.stdout.write('[pipeline] step 5/7 — embedding (optional)\n');
  facts = await embedFacts(facts, opts);

  // ── STEP 6: GRAPH ────────────────────────────────────────────────────────
  process.stdout.write('[pipeline] step 6/7 — building graph edges\n');
  // Give facts stable IDs before edge building
  facts = facts.map(f => {
    if (!f.id) {
      const hash = [...f.fact].reduce((h,c) => (Math.imul(31,h) + c.charCodeAt(0))|0, 0);
      f.id = (f.sourceConvId||'vex') + ':fact:' + Math.abs(hash).toString(36);
    }
    return f;
  });
  const edges = buildEdgesFromFacts(facts);
  process.stdout.write(`[pipeline] ${edges.length} graph edges built\n`);

  // ── STEP 7: STORE ────────────────────────────────────────────────────────
  process.stdout.write('[pipeline] step 7/7 — storing\n');
  if (dryRun) {
    process.stdout.write('\n[pipeline] DRY RUN PREVIEW:\n');
    facts.slice(0, 20).forEach((f, i) => {
      process.stdout.write(`  [${i+1}] (${f.type}, ${f.importance.toFixed(2)}) ${f.fact.slice(0,100)}\n`);
    });
    if (facts.length > 20) process.stdout.write(`  ... and ${facts.length - 20} more\n`);
    process.stdout.write(`\n[pipeline] Would store: ${facts.length} facts, ${edges.length} edges\n`);
    return { upserted: 0, skipped: 0, facts: facts.length, edges: edges.length, mode, dryRun: true };
  }

  const result = await storeFacts(facts, connector, opts);

  // Write edges
  let edgesWritten = 0;
  const dbPath = opts.db || process.env.VEKTOR_DB_PATH || process.env.VEKTOR_DB;
  if (edges.length && dbPath) {
    try {
      const Sqlite = getSqlite();
      if (Sqlite) {
        const db = new Sqlite(dbPath);
        edgesWritten = writeEdgesToDb(db, edges, agentId);
        db.close();
      }
    } catch (e) { process.stderr.write('[pipeline] graph write error: ' + e.message + '\n'); }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  process.stdout.write(`[pipeline] ──────────────────────────────────────────────\n`);
  process.stdout.write(`[pipeline] ✓ complete in ${elapsed}s\n`);
  process.stdout.write(`[pipeline]   conversations : ${conversations.length}\n`);
  process.stdout.write(`[pipeline]   chunks        : ${chunks.length}\n`);
  process.stdout.write(`[pipeline]   facts stored  : ${result.upserted}\n`);
  process.stdout.write(`[pipeline]   duplicates    : ${result.skipped}\n`);
  process.stdout.write(`[pipeline]   graph edges   : ${edgesWritten}\n`);
  process.stdout.write(`[pipeline]   elapsed       : ${elapsed}s\n`);

  return { ...result, facts: facts.length, edges: edgesWritten, mode };
}
