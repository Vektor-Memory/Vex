/**
 * pipeline/04-dedup.js — deduplication
 * Removes near-duplicate facts within an import batch using token overlap.
 * Does NOT require external DB access — operates on the in-memory batch.
 */

function tokenise(text) {
  return new Set(
    (text || '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 3)
  );
}

function jaccard(a, b) {
  const ta = tokenise(a), tb = tokenise(b);
  if (!ta.size || !tb.size) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  return intersection / (ta.size + tb.size - intersection);
}

export function dedupFacts(facts, threshold = 0.72) {
  const kept = [];
  for (const fact of facts) {
    const isDupe = kept.some(k => jaccard(k.fact, fact.fact) >= threshold);
    if (!isDupe) kept.push(fact);
  }
  const removed = facts.length - kept.length;
  if (removed > 0) process.stdout.write(`[dedup] removed ${removed} near-duplicates (threshold=${threshold})\n`);
  return kept;
}

export function dedupAgainstExisting(newFacts, existingTexts, threshold = 0.80) {
  // existingTexts: string[] of content already in DB
  if (!existingTexts.length) return newFacts;
  const filtered = newFacts.filter(f => {
    return !existingTexts.some(e => jaccard(f.fact, e) >= threshold);
  });
  const removed = newFacts.length - filtered.length;
  if (removed > 0) process.stdout.write(`[dedup] ${removed} facts already in DB (skipped)\n`);
  return filtered;
}
