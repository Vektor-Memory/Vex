/**
 * core/migrate.js — reusable migration engine
 * Streaming-aware import/export + vec2vec adapter + re-embedding pipeline
 */

import { getConnector }              from '../connectors/index.js';
import { writeJsonl, writeMeta, readJsonl } from '../formats/vmig.js';
import { reEmbed }                   from '../utils/embed.js';
import { adaptRecords }              from '../utils/adapt.js';
import fs                            from 'fs';
import readline                      from 'readline';

const STREAM_THRESHOLD = 100_000;

// ── DIM CHECK + ADAPTER + REEMBED ────────────────────────────────────────────

export async function dimCheck(records, targetDims, opts) {
  if (!targetDims) return records;

  const mismatched = records.filter(r => r.vector && r.vector.length !== targetDims);
  if (!mismatched.length) return records;

  console.warn(`[core] ⚠ ${mismatched.length} records have dim mismatch (expected ${targetDims})`);

  if (opts.adapter) {
    const targetModel = opts['adapter-model'] || opts['embed-model'];
    if (!targetModel) throw new Error('[core] --adapter requires --adapter-model <model-name>');
    console.log(`[core] --adapter: projecting via vex-adapter → ${targetModel}`);
    await adaptRecords(mismatched, targetModel, opts);
    const stillBad = records.filter(r => r.vector && r.vector.length !== targetDims);
    if (stillBad.length) {
      console.warn(`[core] ⚠ ${stillBad.length} records still mismatched after projection — will be skipped`);
    }
    return records;
  }

  if (opts.reembed) {
    const reembeddable = mismatched.filter(r => r.text);
    const noText       = mismatched.length - reembeddable.length;
    if (noText) console.error(`[core] ✗ ${noText} mismatched records have no text — cannot re-embed, will be skipped`);
    if (reembeddable.length) {
      console.log(`[core] --reembed: re-embedding ${reembeddable.length} records`);
      await reEmbed(reembeddable, opts);
      const idx = new Map(reembeddable.map(r => [r.id, r]));
      for (let i = 0; i < records.length; i++) {
        const updated = idx.get(records[i].id);
        if (updated) records[i] = updated;
      }
    }
    return records;
  }

  const noText = mismatched.filter(r => !r.text).length;
  if (noText) {
    console.error(`[core] ✗ ${noText} records cannot be resolved (no text, no --adapter). They will be skipped.`);
  } else {
    console.warn(`[core] tip: use --reembed to re-embed from text, or --adapter for vec2vec projection`);
  }

  return records;
}

// ── STREAMING EXPORT ──────────────────────────────────────────────────────────

export async function streamExport(connector, opts, outPath) {
  const tmpPath   = outPath + '.tmp';
  const outStream = fs.createWriteStream(tmpPath, { encoding: 'utf8' });
  let total = 0;

  const writePage = async (page) => {
    for (const r of page) {
      outStream.write(JSON.stringify(r) + '\n');
      total++;
    }
  };

  if (typeof connector.extractStream === 'function') {
    await connector.extractStream(opts, writePage);
  } else {
    console.warn(`[core] connector "${connector.name}" has no extractStream — loading full dataset`);
    const records = await connector.extract(opts);
    await writePage(records);
  }

  await new Promise((res, rej) => {
    outStream.end();
    outStream.on('finish', res);
    outStream.on('error',  rej);
  });

  fs.renameSync(tmpPath, outPath);
  console.log(`[core] streamed ${total} records → ${outPath}`);
  return total;
}

// ── STREAMING IMPORT ──────────────────────────────────────────────────────────

/**
 * Read a .vmig.jsonl file line-by-line and load into connector in batches.
 * Upserted/skipped counts come from the connector's load() return value —
 * the connector is the source of truth, not vector-presence heuristics.
 *
 * @returns {{ total, upserted, skipped }}
 */
export async function streamImport(filePath, connector, opts, batchSize = 500) {
  if (!fs.existsSync(filePath)) throw new Error(`[core] file not found: ${filePath}`);

  const rl = readline.createInterface({ input: fs.createReadStream(filePath) });

  let batch    = [];
  let total    = 0;
  let upserted = 0;
  let skipped  = 0;

  let targetDims = null;

  const flushBatch = async () => {
    if (!batch.length) return;

    const resolved = await dimCheck(batch, targetDims, opts);
    const result   = await connector.load(resolved, opts);

    // Use connector's own counts if returned, otherwise fall back to batch size
    if (result && typeof result.upserted === 'number') {
      upserted += result.upserted;
      skipped  += result.skipped ?? 0;
    } else {
      // Connector didn't return counts — assume all succeeded
      upserted += resolved.length;
    }

    process.stdout.write(`\r[core] imported ${upserted} | skipped ${skipped}`);
    batch = [];
  };

  for await (const line of rl) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    try {
      batch.push(JSON.parse(t));
    } catch {
      console.warn(`\n[core] skipping malformed JSON at record ${total}`);
      continue;
    }
    total++;
    if (batch.length >= batchSize) await flushBatch();
  }

  await flushBatch();

  process.stdout.write('\n');
  console.log(`[core] ✓ stream import complete — ${upserted} upserted / ${skipped} skipped / ${total} total`);
  return { total, upserted, skipped };
}

// ── FULL MIGRATE PIPELINE ─────────────────────────────────────────────────────

export async function migrate(fromConnector, toConnector, opts) {
  if (fromConnector.name === 'jsonl') {
    const filePath  = opts.from || opts.file || opts.input;
    const lineCount = await countLines(filePath);
    console.log(`[core] ${lineCount.toLocaleString()} records in file`);

    if (lineCount > STREAM_THRESHOLD) {
      console.log(`[core] streaming mode activated (>${STREAM_THRESHOLD.toLocaleString()} records)`);
      return streamImport(filePath, toConnector, opts);
    }
  }

  const records    = await fromConnector.extract(opts);
  const targetDims = await resolveTargetDims(toConnector, opts);
  const resolved   = await dimCheck(records, targetDims, opts);
  const result     = await toConnector.load(resolved, opts);

  // Use connector's own counts if returned
  const upserted = (result && typeof result.upserted === 'number')
    ? result.upserted
    : resolved.filter(r => r.vector).length;
  const skipped = (result && typeof result.skipped === 'number')
    ? result.skipped
    : resolved.filter(r => !r.vector).length;

  return { total: records.length, upserted, skipped };
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

async function countLines(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return 0;
  let count = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(filePath) });
  for await (const _ of rl) count++;
  return count;
}

async function resolveTargetDims(connector, opts) {
  if (typeof connector.getDims === 'function') {
    try { return await connector.getDims(opts); } catch { /* non-fatal */ }
  }
  return null;
}
