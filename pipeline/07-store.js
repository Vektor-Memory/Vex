/**
 * pipeline/07-store.js — store extracted facts into target connector
 * Converts pipeline facts to vmig records and calls connector.load()
 */

import { toRecord } from '../formats/vmig.js';

export function factsToRecords(facts, opts = {}) {
  const namespace = opts.namespace || 'extracted';
  return facts.map(f => {
    // Build a unique ID from source + hash of fact text
    const hash = [...f.fact].reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0);
    const id = (f.sourceConvId || 'vex') + ':fact:' + Math.abs(hash).toString(36);

    return toRecord({
      id,
      text: f.fact,
      vector: f.vector || null,
      namespace,
      created_at: f.created_at ? Math.floor(new Date(f.created_at).getTime() / 1000) : Math.floor(Date.now() / 1000),
      metadata: {
        type:             f.type || 'fact',
        importance:       f.importance || 0.6,
        entities:         f.entities || [],
        tags:             f.tags || [],
        potential:        f.potential || [],
        source_conv_id:   f.sourceConvId,
        source_conv_name: f.sourceConvName,
        source_format:    'vex-pipeline',
        chunk_mode:       'extracted',
      },
    }, 'vex-pipeline');
  });
}

export async function storeFacts(facts, connector, opts = {}) {
  const records = factsToRecords(facts, opts);
  if (!records.length) { process.stdout.write('[store] no facts to store\n'); return { upserted: 0, skipped: 0 }; }
  process.stdout.write(`[store] writing ${records.length} facts → ${connector.name}\n`);

  // For VEKTOR/SQLite connectors: pre-assign integer-compatible IDs to avoid FTS rowid mismatch
  // FTS5 requires rowid to be INTEGER — use timestamp-based numeric IDs
  const now = Date.now();
  records.forEach((r, i) => {
    // Keep original ID in metadata, use numeric rowid-friendly ID as primary
    if (r.id && typeof r.id === 'string' && !/^\d+$/.test(r.id)) {
      if (!r.metadata) r.metadata = {};
      r.metadata.original_id = r.id;
      r.id = String(now + i); // numeric string — safe for FTS rowid cast
    }
  });

  const result = await connector.load(records, opts);
  return result || { upserted: records.length, skipped: 0 };
}
