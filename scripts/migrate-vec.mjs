#!/usr/bin/env node
/**
 * scripts/migrate-vec.mjs
 *
 * Adds sqlite-vec ANN support to an existing VEKTOR memories database.
 *
 * What it does:
 *   1. Loads the sqlite-vec extension into the DB
 *   2. Creates the memories_vec virtual table (vec0) if not present
 *   3. Backfills all existing memory embeddings into memories_vec
 *   4. Verifies rowid alignment between memories and memories_vec
 *
 * Usage:
 *   node scripts/migrate-vec.mjs --db ./slipstream-memory.db
 *   node scripts/migrate-vec.mjs --db ./slipstream-memory.db --dims 768
 *   node scripts/migrate-vec.mjs --db ./slipstream-memory.db --dry-run
 */

import { createRequire } from 'module';
import { parseArgs }     from 'util';
import { existsSync }    from 'fs';

// ── CLI ARGS ──────────────────────────────────────────────────────────────────

const { values: opts } = parseArgs({
  options: {
    db:      { type: 'string',  short: 'd', default: 'slipstream-memory.db' },
    dims:    { type: 'string',  short: 'n', default: '384' },
    'dry-run': { type: 'boolean', default: false },
    'batch-size': { type: 'string', default: '500' },
    help:    { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

if (opts.help) {
  console.log(`
  migrate-vec.mjs — Add sqlite-vec ANN index to a VEKTOR memories DB

  Options:
    --db <path>         Path to SQLite database  (default: slipstream-memory.db)
    --dims <n>          Vector dimensions         (default: 384)
    --dry-run           Check only, no writes
    --batch-size <n>    Backfill batch size       (default: 500)
    -h, --help          Show this help
  `);
  process.exit(0);
}

const DB_PATH   = opts.db;
const DIMS      = parseInt(opts.dims);
const DRY_RUN   = opts['dry-run'];
const BATCH     = parseInt(opts['batch-size']);

// ── LOAD DEPS ─────────────────────────────────────────────────────────────────

const require = createRequire(import.meta.url);

// better-sqlite3 — peer dep
let Database;
try {
  Database = require('better-sqlite3');
} catch {
  console.error('[migrate-vec] ✗ better-sqlite3 not found. Run: npm install better-sqlite3');
  process.exit(1);
}

// sqlite-vec — peer dep
let sqliteVec;
try {
  sqliteVec = require('sqlite-vec');
} catch {
  console.error('[migrate-vec] ✗ sqlite-vec not found. Run: npm install sqlite-vec');
  process.exit(1);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

if (!existsSync(DB_PATH)) {
  console.error(`[migrate-vec] ✗ database not found: ${DB_PATH}`);
  process.exit(1);
}

console.log(`\n[migrate-vec] database : ${DB_PATH}`);
console.log(`[migrate-vec] dims     : ${DIMS}`);
console.log(`[migrate-vec] dry-run  : ${DRY_RUN}`);
console.log(`[migrate-vec] batch    : ${BATCH}\n`);

const db = new Database(DB_PATH);

// ── STEP 1: Load sqlite-vec extension ─────────────────────────────────────────

try {
  sqliteVec.load(db);
  const { vec_version } = db.prepare('SELECT vec_version() AS vec_version').get();
  console.log(`[migrate-vec] ✓ sqlite-vec loaded — version ${vec_version}`);
} catch (e) {
  console.error(`[migrate-vec] ✗ failed to load sqlite-vec extension: ${e.message}`);
  db.close();
  process.exit(1);
}

// ── STEP 2: Check memories table ──────────────────────────────────────────────

const memoriesExists = db.prepare(
  `SELECT name FROM sqlite_master WHERE type='table' AND name='memories'`
).get();

if (!memoriesExists) {
  console.error('[migrate-vec] ✗ memories table not found — is this a VEKTOR database?');
  db.close();
  process.exit(1);
}

const { total } = db.prepare(`SELECT COUNT(*) AS total FROM memories`).get();
const { withVec } = db.prepare(
  `SELECT COUNT(*) AS withVec FROM memories WHERE embedding IS NOT NULL`
).get();

console.log(`[migrate-vec] memories total    : ${total}`);
console.log(`[migrate-vec] memories with vec : ${withVec}`);

if (withVec === 0) {
  console.warn('[migrate-vec] ⚠  no embeddings found — memories_vec will be empty');
}

// ── STEP 3: Check/create memories_vec ─────────────────────────────────────────

const vecTableExists = db.prepare(
  `SELECT name FROM sqlite_master WHERE type='table' AND name='memories_vec'`
).get();

if (vecTableExists) {
  console.log('[migrate-vec] memories_vec already exists — checking health...');

  // probe it
  try {
    db.prepare(`SELECT rowid FROM memories_vec LIMIT 0`).all();
    const { vecCount } = db.prepare(
      `SELECT COUNT(*) AS vecCount FROM memories_vec`
    ).get();
    console.log(`[migrate-vec] memories_vec rows : ${vecCount}`);

    if (vecCount === withVec) {
      console.log('[migrate-vec] ✓ already in sync — nothing to do');
      db.close();
      process.exit(0);
    }
    console.log(`[migrate-vec] ⚠  out of sync (${vecCount} vec vs ${withVec} embeddings) — resyncing`);
  } catch (e) {
    console.warn(`[migrate-vec] memories_vec broken (${e.message}) — dropping and recreating`);
    if (!DRY_RUN) {
      db.exec(`DROP TABLE IF EXISTS memories_vec`);
    }
  }
} else {
  console.log('[migrate-vec] memories_vec not found — will create');
}

if (DRY_RUN) {
  console.log('\n[migrate-vec] dry-run — no changes made');
  db.close();
  process.exit(0);
}

// ── STEP 4: Create vec0 virtual table ─────────────────────────────────────────

try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec
    USING vec0(embedding FLOAT[${DIMS}])
  `);
  console.log(`[migrate-vec] ✓ memories_vec created (FLOAT[${DIMS}])`);
} catch (e) {
  console.error(`[migrate-vec] ✗ failed to create memories_vec: ${e.message}`);
  db.close();
  process.exit(1);
}

// ── STEP 5: Backfill embeddings ───────────────────────────────────────────────

console.log(`\n[migrate-vec] backfilling ${withVec} embeddings in batches of ${BATCH}...`);

const rows = db.prepare(
  `SELECT id, embedding FROM memories WHERE embedding IS NOT NULL ORDER BY rowid`
).all();

const insertVec = db.prepare(
  `INSERT OR REPLACE INTO memories_vec(rowid, embedding) VALUES (?, ?)`
);

// We need rowid for vec0, not the uuid id. Get the rowid mapping.
const rowidMap = db.prepare(
  `SELECT rowid, id FROM memories WHERE embedding IS NOT NULL`
).all();

const byId = new Map(rowidMap.map(r => [r.id, r.rowid]));

let inserted = 0;
let skipped  = 0;
let errors   = 0;

const backfill = db.transaction((batch) => {
  for (const row of batch) {
    try {
      const rowid = byId.get(row.id);
      if (!rowid) { skipped++; continue; }

      // Convert stored BLOB → Float32Array → ensure correct dims
      const buf    = Buffer.isBuffer(row.embedding)
        ? row.embedding
        : Buffer.from(row.embedding);
      const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

      if (floats.length !== DIMS) {
        process.stderr.write(
          `\n[migrate-vec] skip id=${row.id} — dim mismatch (${floats.length} vs ${DIMS})`
        );
        skipped++;
        continue;
      }

      // sqlite-vec expects raw Float32Array buffer
      insertVec.run(rowid, Buffer.from(floats.buffer));
      inserted++;
    } catch (e) {
      errors++;
      process.stderr.write(`\n[migrate-vec] error id=${row.id}: ${e.message}`);
    }
  }
});

for (let i = 0; i < rows.length; i += BATCH) {
  backfill(rows.slice(i, i + BATCH));
  const pct = Math.min(100, Math.round(((i + BATCH) / rows.length) * 100));
  process.stdout.write(`\r[migrate-vec] ${inserted} inserted | ${skipped} skipped | ${errors} errors (${pct}%)`);
}
process.stdout.write('\n');

// ── STEP 6: Verify alignment ──────────────────────────────────────────────────

const { vecCount: finalCount } = db.prepare(
  `SELECT COUNT(*) AS vecCount FROM memories_vec`
).get();

console.log(`\n[migrate-vec] ── summary ────────────────────────`);
console.log(`[migrate-vec]   memories with embeddings : ${withVec}`);
console.log(`[migrate-vec]   memories_vec rows        : ${finalCount}`);
console.log(`[migrate-vec]   inserted                 : ${inserted}`);
console.log(`[migrate-vec]   skipped (dim/rowid)      : ${skipped}`);
console.log(`[migrate-vec]   errors                   : ${errors}`);

// Quick ANN probe
try {
  const probe = new Float32Array(DIMS).fill(0.1);
  const testResults = db.prepare(`
    SELECT rowid, distance
    FROM memories_vec
    WHERE embedding MATCH ?
    AND k = 3
  `).all(Buffer.from(probe.buffer));
  console.log(`[migrate-vec]   ANN probe (k=3)          : ${testResults.length} results ✓`);
} catch (e) {
  console.warn(`[migrate-vec]   ANN probe failed: ${e.message}`);
}

if (errors === 0 && finalCount === inserted) {
  console.log(`\n[migrate-vec] ✓ migration complete\n`);
} else {
  console.warn(`\n[migrate-vec] ⚠  migration complete with warnings — check errors above\n`);
}

db.close();
