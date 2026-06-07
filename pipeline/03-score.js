/**
 * pipeline/03-score.js — importance and recency scoring
 * Adjusts importance scores based on recency, entity density, and type weights.
 */

const TYPE_WEIGHTS = {
  decision:     1.0,
  preference:   0.95,
  relationship: 0.85,
  action:       0.80,
  entity:       0.75,
  fact:         0.70,
};

const BOOST_PATTERNS = [
  [/\b(decided|decision|agreed|will|won't|never|always|prefer)\b/i, 0.10],
  [/\b(important|critical|must|required|essential|key)\b/i, 0.08],
  [/\b(project|product|deploy|launch|release|version)\b/i, 0.06],
  [/\b(bug|fix|error|issue|problem|broken)\b/i, 0.05],
];

function recencyScore(createdAt) {
  if (!createdAt) return 0.5;
  const ts = typeof createdAt === 'number' ? createdAt * 1000 : new Date(createdAt).getTime();
  if (isNaN(ts)) return 0.5;
  const ageDays = (Date.now() - ts) / 86400000;
  // Recency bonus: 0.1 for today, 0 at 90 days+
  return Math.max(0, 0.1 * Math.exp(-ageDays / 30));
}

export function scoreFacts(facts) {
  return facts.map(f => {
    let score = f.importance || 0.6;

    // Type weight
    const tw = TYPE_WEIGHTS[f.type] || 0.70;
    score = score * tw + score * (1 - tw) * 0.5;

    // Boost patterns
    for (const [pattern, boost] of BOOST_PATTERNS) {
      if (pattern.test(f.fact)) score = Math.min(1.0, score + boost);
    }

    // Entity density bonus
    const entityBonus = Math.min(0.10, (f.entities?.length || 0) * 0.02);
    score = Math.min(1.0, score + entityBonus);

    // Recency bonus
    score = Math.min(1.0, score + recencyScore(f.created_at));

    return { ...f, importance: parseFloat(score.toFixed(4)) };
  });
}

export function filterByImportance(facts, minImportance = 0.5) {
  return facts.filter(f => f.importance >= minImportance);
}
