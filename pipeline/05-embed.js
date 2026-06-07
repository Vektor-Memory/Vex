/**
 * pipeline/05-embed.js — optional embedding
 * Adds vectors to facts using OpenAI, Ollama, or any compatible endpoint.
 * If no embed provider is configured, facts are stored text-only (BM25 search still works).
 */

const BATCH_SIZE = 64;

function resolveEmbedProvider(opts) {
  if (opts['embed-url']) {
    return {
      type: 'openai-compat',
      url: opts['embed-url'],
      model: opts['embed-model'] || 'text-embedding-3-small',
      key: opts['embed-key'] || opts['openai-key'] || process.env.OPENAI_API_KEY || '',
    };
  }
  if (opts['openai-key'] || process.env.OPENAI_API_KEY) {
    return {
      type: 'openai-compat',
      url: 'https://api.openai.com/v1/embeddings',
      model: opts['embed-model'] || 'text-embedding-3-small',
      key: opts['openai-key'] || process.env.OPENAI_API_KEY,
    };
  }
  if (opts['ollama-url'] || process.env.OLLAMA_URL) {
    return {
      type: 'ollama',
      url: (opts['ollama-url'] || process.env.OLLAMA_URL || 'http://localhost:11434') + '/api/embeddings',
      model: opts['embed-model'] || 'nomic-embed-text',
    };
  }
  return null;
}

async function embedBatch(texts, provider) {
  if (provider.type === 'ollama') {
    // Ollama embeds one at a time
    const vectors = [];
    for (const text of texts) {
      const res = await fetch(provider.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: provider.model, prompt: text }),
        signal: AbortSignal.timeout(30000),
      });
      const d = await res.json();
      vectors.push(d.embedding || null);
    }
    return vectors;
  }

  // OpenAI-compatible batch
  const headers = { 'Content-Type': 'application/json' };
  if (provider.key) headers['Authorization'] = 'Bearer ' + provider.key;
  const res = await fetch(provider.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: provider.model, input: texts }),
    signal: AbortSignal.timeout(30000),
  });
  const d = await res.json();
  if (d.error) throw new Error('Embed error: ' + JSON.stringify(d.error));
  const sorted = (d.data || []).sort((a, b) => (a.index || 0) - (b.index || 0));
  return sorted.map(x => x.embedding || null);
}

export async function embedFacts(facts, opts = {}) {
  const provider = resolveEmbedProvider(opts);
  if (!provider) {
    process.stdout.write('[embed] no embed provider — skipping vectors (text search still works)\n');
    return facts;
  }

  process.stdout.write(`[embed] provider=${provider.type} model=${provider.model}\n`);
  let done = 0;

  for (let i = 0; i < facts.length; i += BATCH_SIZE) {
    const batch = facts.slice(i, i + BATCH_SIZE);
    const texts = batch.map(f => f.fact);
    try {
      const vectors = await embedBatch(texts, provider);
      for (let j = 0; j < batch.length; j++) {
        if (vectors[j]) {
          batch[j].vector = vectors[j];
          batch[j].model  = provider.model;
          batch[j].dims   = vectors[j].length;
        }
      }
    } catch (e) {
      process.stderr.write('\n[embed] batch error: ' + e.message + ' — continuing without vectors\n');
    }
    done += batch.length;
    process.stdout.write(`\r[embed] ${done}/${facts.length}`);
  }
  process.stdout.write('\n');
  const withVec = facts.filter(f => f.vector).length;
  process.stdout.write(`[embed] ${withVec}/${facts.length} facts have vectors\n`);
  return facts;
}
