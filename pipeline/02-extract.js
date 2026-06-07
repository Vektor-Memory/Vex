/**
 * pipeline/02-extract.js — LLM fact extraction with provider cascade
 *
 * Features:
 *   - Provider chain: groq → ollama → openai → anthropic (waterfall failover)
 *   - Key rotation: multiple groq/openai keys via comma-separated --groq-key k1,k2,k3
 *   - Spec decoding: Ollama draft model for 2-4x speed (--ollama-draft llama3.2)
 *   - Auto-backoff: reads exact retry-after from rate limit headers
 *   - Never stops: exhausted chunks are skipped + logged, job always finishes
 *   - --provider auto: reads vektor config, builds chain from all configured keys
 *
 * CLI flags:
 *   --provider        auto | groq,ollama,openai | single name (default: auto)
 *   --groq-key        key1,key2,key3  (rotated round-robin)
 *   --openai-key      key
 *   --anthropic-key   key
 *   --ollama-url      http://localhost:11434
 *   --ollama-draft    llama3.2  (draft model for spec decoding)
 *   --extract-model   override model per provider: groq:llama-3.3-70b,ollama:mistral
 *   --extract-url     custom OpenAI-compatible endpoint
 *   --extract-key     key for --extract-url
 *   --concurrency     parallel LLM calls (default: 3, use 1 for free Groq)
 *   --rate-limit      fixed ms delay between batches (overrides adaptive)
 */

// ── Prompt ────────────────────────────────────────────────────────────────────

const EXTRACT_PROMPT = `You are a precise memory extraction system. Extract discrete, self-contained facts from this conversation.

Rules:
- Each fact must be ONE sentence, fully self-contained (no pronouns without referents)
- Include WHO did/said/decided WHAT, with context
- Capture: decisions, preferences, technical facts, action items, entities, relationships
- Skip: greetings, pleasantries, errors, repetitions, meta-commentary about the conversation
- Max 8 facts per chunk. Fewer is better — quality over quantity.
- Importance: 0.0-1.0 (0.9+=critical decision/preference, 0.7-0.9=useful fact, 0.5-0.7=context, <0.5=skip)
- Only include facts with importance >= 0.5
- tags: 1-4 short lowercase keywords categorizing the fact (e.g. "config", "bug", "preference", "deploy")
- potential: exactly 3 short natural-language questions this fact would answer when searched later

Output ONLY valid JSON array, no markdown, no preamble:
[{"fact":"...","type":"decision|preference|fact|entity|action|relationship","importance":0.0-1.0,"entities":["entity1","entity2"],"tags":["tag1","tag2"],"potential":["question 1?","question 2?","question 3?"]}]

Conversation title: {TITLE}
Conversation:
{TEXT}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isRateLimitError(e) {
  const msg = (e.message || '').toLowerCase();
  return msg.includes('rate limit') || msg.includes('rate_limit') ||
         msg.includes('too many requests') || msg.includes('429') ||
         msg.includes('tokens per minute') || msg.includes('tpm');
}

function isTransientError(e) {
  const msg = (e.message || '').toLowerCase();
  return isRateLimitError(e) ||
         msg.includes('timeout') || msg.includes('econnrefused') ||
         msg.includes('network') || msg.includes('503') || msg.includes('502');
}

function parseRetryAfter(errorMessage) {
  // Extract exact wait time from Groq/OpenAI rate limit messages
  // "Please try again in 3.435s" or "try again in 1m30s"
  const secMatch  = errorMessage.match(/try again in ([\d.]+)s/i);
  const minSecMatch = errorMessage.match(/try again in (\d+)m(\d+)s/i);
  if (minSecMatch) return (parseInt(minSecMatch[1]) * 60 + parseFloat(minSecMatch[2])) * 1000 + 300;
  if (secMatch)    return Math.ceil(parseFloat(secMatch[1]) * 1000) + 300;
  return null;
}

const SKIP_PATTERNS = [
  /^(hi|hello|hey|thanks|thank you|ok|okay|sure|yes|no|bye|goodbye)[.!?\s]*$/i,
  /^(sounds good|great|perfect|awesome|got it|understood)[.!?\s]*$/i,
];

function shouldSkipChunk(text) {
  if (!text || text.trim().length < 50) return true;
  if (SKIP_PATTERNS.some(p => p.test(text.trim()))) return true;
  return false;
}

function buildPrompt(chunk) {
  const preview = chunk.text.slice(0, 8000);
  return EXTRACT_PROMPT
    .replace('{TITLE}', chunk.convName || 'Untitled')
    .replace('{TEXT}', preview);
}

// ── Provider resolution ───────────────────────────────────────────────────────

const PROVIDER_DEFAULTS = {
  groq:      { endpoint: 'https://api.groq.com/openai/v1/chat/completions',    model: 'llama-3.1-8b-instant',      tpmLimit: 6000  },
  openai:    { endpoint: 'https://api.openai.com/v1/chat/completions',         model: 'gpt-4o-mini',               tpmLimit: 60000 },
  anthropic: { endpoint: 'https://api.anthropic.com/v1/messages',              model: 'claude-haiku-4-5-20251001', tpmLimit: 20000, isAnthropic: true },
  mistral:   { endpoint: 'https://api.mistral.ai/v1/chat/completions',         model: 'mistral-small-latest',      tpmLimit: 10000 },
  together:  { endpoint: 'https://api.together.xyz/v1/chat/completions',       model: 'meta-llama/Llama-3.2-3B-Instruct-Turbo', tpmLimit: 30000 },
  ollama:    { endpoint: 'http://localhost:11434/api/chat',                     model: 'llama3.2',                  tpmLimit: Infinity, isOllama: true },
};

function parseModelOverrides(extractModel) {
  // --extract-model groq:llama-3.3-70b,ollama:mistral OR just llama-3.3-70b
  if (!extractModel) return {};
  const overrides = {};
  if (extractModel.includes(':')) {
    for (const part of extractModel.split(',')) {
      const [provider, model] = part.trim().split(':');
      if (provider && model) overrides[provider.toLowerCase()] = model;
    }
  } else {
    // Single model — apply to all
    overrides['*'] = extractModel.trim();
  }
  return overrides;
}

function readVektorConfig() {
  try {
    const os = require('os');
    const path = require('path');
    const IS_WIN = process.platform === 'win32';
    const cfgPath = IS_WIN
      ? path.join(process.env.APPDATA || os.homedir(), 'vektor', 'config.json')
      : path.join(os.homedir(), '.config', 'vektor', 'config.json');
    if (fs.existsSync(cfgPath)) return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {}
  return {};
}

/**
 * buildProviderChain(opts) — returns ordered array of provider objects.
 * Each provider may have multiple apiKeys (for round-robin rotation).
 */
export function buildProviderChain(opts) {
  const modelOverrides = parseModelOverrides(opts['extract-model']);
  const vektorCfg = (opts.provider === 'auto' || !opts.provider) ? readVektorConfig() : {};
  const chain = [];

  function getModel(name, defaultModel) {
    return modelOverrides[name] || modelOverrides['*'] || defaultModel;
  }

  function addProvider(name, keys, extraOpts = {}) {
    if (!keys || !keys.filter(Boolean).length) return;
    const def = PROVIDER_DEFAULTS[name] || {};
    chain.push({
      name,
      keys: keys.filter(Boolean), // array for rotation
      keyIndex: 0,                 // current key index
      get apiKey() { return this.keys[this.keyIndex % this.keys.length]; },
      rotateKey() { this.keyIndex++; process.stderr.write('[extract] rotating to next ' + name + ' key\n'); },
      endpoint: extraOpts.endpoint || def.endpoint,
      model:    getModel(name, def.model || 'default'),
      tpmLimit: def.tpmLimit || Infinity,
      isOllama:    def.isOllama    || false,
      isAnthropic: def.isAnthropic || false,
      coolUntil: 0, // timestamp when this provider is available again
      ...extraOpts,
    });
  }

  // Determine provider order
  const providerOrder = opts.provider && opts.provider !== 'auto'
    ? opts.provider.split(',').map(p => p.trim().toLowerCase())
    : ['groq', 'ollama', 'openai', 'anthropic', 'mistral', 'together', 'custom'];

  for (const name of providerOrder) {
    if (name === 'groq') {
      const keys = (opts['groq-key'] || process.env.GROQ_API_KEY || vektorCfg['groq-api-key'] || '')
        .split(',').map(k => k.trim()).filter(Boolean);
      addProvider('groq', keys);
    } else if (name === 'openai') {
      const keys = (opts['openai-key'] || process.env.OPENAI_API_KEY || vektorCfg['openai-api-key'] || '')
        .split(',').map(k => k.trim()).filter(Boolean);
      addProvider('openai', keys);
    } else if (name === 'anthropic' || name === 'claude') {
      const keys = (opts['anthropic-key'] || process.env.ANTHROPIC_API_KEY || vektorCfg['anthropic-api-key'] || '')
        .split(',').map(k => k.trim()).filter(Boolean);
      addProvider('anthropic', keys);
    } else if (name === 'mistral') {
      const keys = (opts['mistral-key'] || process.env.MISTRAL_API_KEY || vektorCfg['mistral-api-key'] || '')
        .split(',').map(k => k.trim()).filter(Boolean);
      addProvider('mistral', keys);
    } else if (name === 'together') {
      const keys = (opts['together-key'] || process.env.TOGETHER_API_KEY || vektorCfg['together-api-key'] || '')
        .split(',').map(k => k.trim()).filter(Boolean);
      addProvider('together', keys);
    } else if (name === 'ollama') {
      const url = opts['ollama-url'] || process.env.OLLAMA_URL || vektorCfg['ollama-url'] || 'http://localhost:11434';
      const draftModel = opts['ollama-draft'];
      addProvider('ollama', ['local'], {
        endpoint: url + '/api/chat',
        draftModel: draftModel || null, // for spec decoding
      });
    } else if (name === 'custom' && opts['extract-url']) {
      addProvider('custom', [opts['extract-key'] || ''], {
        endpoint: opts['extract-url'],
        model: getModel('custom', opts['extract-model'] || 'local'),
      });
    }
  }

  return chain;
}

// ── LLM call (single provider) ────────────────────────────────────────────────

async function callLLM(prompt, provider) {
  const { endpoint, apiKey, model, isOllama, isAnthropic, draftModel } = provider;

  if (isAnthropic) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 600, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(30000),
    });
    const d = await res.json();
    if (d.error) throw new Error('Anthropic: ' + d.error.message);
    return d.content?.[0]?.text || '';
  }

  if (isOllama) {
    // Spec decoding: use draft model if configured
    if (draftModel) {
      const body = {
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        options: { temperature: 0.1, num_predict: 1400, num_draft: 8 },
      };
      // Ollama spec decoding: set draft model via options
      body.options.draft_model = draftModel;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90000),
      });
      const d = await res.json();
      if (d.error) throw new Error('Ollama: ' + d.error);
      return d.message?.content || '';
    }
    // Standard Ollama
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false, options: { temperature: 0.1, num_predict: 1400 } }),
      signal: AbortSignal.timeout(90000),
    });
    const d = await res.json();
    if (d.error) throw new Error('Ollama: ' + d.error);
    return d.message?.content || '';
  }

  // OpenAI-compatible
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 1400, temperature: 0.1 }),
    signal: AbortSignal.timeout(30000),
  });
  const d = await res.json();
  if (d.error) throw new Error(provider.name + ': ' + JSON.stringify(d.error));
  return d.choices?.[0]?.message?.content || '';
}

// ── Waterfall fallback ────────────────────────────────────────────────────────

async function callWithFallback(prompt, chain, chunkId) {
  const now = Date.now();
  const available = chain.filter(p => now >= (p.coolUntil || 0));

  if (!available.length) {
    // All on cooldown — wait for soonest available
    const soonest = Math.min(...chain.map(p => p.coolUntil || 0));
    const waitMs = Math.max(0, soonest - now) + 200;
    process.stderr.write('[extract] all providers cooling — waiting ' + (waitMs/1000).toFixed(1) + 's\n');
    await sleep(waitMs);
    return callWithFallback(prompt, chain, chunkId);
  }

  for (const provider of available) {
    try {
      const result = await callLLM(prompt, provider);
      return result;
    } catch (e) {
      if (isRateLimitError(e)) {
        // Parse exact retry-after and set cooldown on this provider
        const waitMs = parseRetryAfter(e.message) || 12000;
        provider.coolUntil = Date.now() + waitMs;

        // Try rotating to next key on the same provider
        if (provider.keys.length > 1) {
          provider.rotateKey();
          try {
            const result = await callLLM(prompt, provider);
            return result; // key rotation worked
          } catch (e2) {
            if (isRateLimitError(e2)) {
              // All keys for this provider are rate-limited
              process.stderr.write('[extract] ' + provider.name + ' all keys rate-limited → trying next provider\n');
            } else {
              process.stderr.write('[extract] ' + provider.name + ' key rotation failed: ' + e2.message + '\n');
            }
          }
        } else {
          process.stderr.write('[extract] ' + provider.name + ' rate-limited (cool ' + (waitMs/1000).toFixed(1) + 's) → trying next\n');
        }
        // Fall through to next provider
        continue;
      }

      if (isTransientError(e)) {
        process.stderr.write('[extract] ' + provider.name + ' transient error → next provider: ' + e.message.slice(0, 80) + '\n');
        continue;
      }

      // Non-transient error (auth, malformed) — don't try other providers for auth issues
      if (e.message.includes('401') || e.message.includes('auth') || e.message.includes('API key')) {
        process.stderr.write('[extract] ' + provider.name + ' auth error — skipping provider: ' + e.message.slice(0, 80) + '\n');
        continue;
      }

      // Unknown error — log and try next
      process.stderr.write('[extract] ' + provider.name + ' error → next: ' + e.message.slice(0, 80) + '\n');
      continue;
    }
  }

  // All providers exhausted for this chunk
  return null;
}

// ── Output parser ─────────────────────────────────────────────────────────────

function parseExtracted(raw, chunk) {
  if (!raw || !raw.trim()) return [];
  let text = raw.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '').trim();
  const start = text.indexOf('[');
  const end   = text.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(f => f && typeof f.fact === 'string' && f.fact.trim().length > 10)
      .filter(f => (f.importance || 0) >= 0.5)
      .map(f => ({
        fact:           f.fact.trim(),
        type:           f.type || 'fact',
        importance:     Math.min(1, Math.max(0, parseFloat(f.importance) || 0.6)),
        entities:       Array.isArray(f.entities) ? f.entities.filter(e => typeof e === 'string') : [],
        tags:           Array.isArray(f.tags) ? f.tags.filter(t => typeof t === 'string').map(t => t.trim().toLowerCase()).slice(0, 6) : [],
        potential:      Array.isArray(f.potential) ? f.potential.filter(p => typeof p === 'string').slice(0, 3) : [],
        sourceChunkId:  chunk.id,
        sourceConvId:   chunk.convId,
        sourceConvName: chunk.convName,
        created_at:     chunk.created_at,
      }));
  } catch { return []; }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * resolveProvider(opts) — backwards-compatible single provider resolver
 * Used by pipeline/index.js to check if any provider is available
 */
export function resolveProvider(opts) {
  const chain = buildProviderChain(opts);
  return chain.length ? chain[0] : null;
}

/**
 * extractFacts(chunks, opts) — main extraction entry point
 */
export async function extractFacts(chunks, opts = {}) {
  const chain = buildProviderChain(opts);

  if (!chain.length) {
    throw new Error(
      'No LLM provider configured for extraction.\n' +
      'Set one of: --groq-key, --openai-key, --anthropic-key, --ollama-url\n' +
      'Or use --mode raw to skip extraction.'
    );
  }

  const concurrency = parseInt(opts.concurrency || '3');
  const dryRun      = opts['dry-run'] || false;
  const allFacts    = [];
  let processed = 0, skipped = 0, errors = 0, fallbacks = 0;

  // Log provider chain
  process.stdout.write('[extract] provider chain: ' + chain.map(p => {
    const keyCount = p.keys.filter(k => k && k !== 'local').length;
    return p.name + (keyCount > 1 ? '(x' + keyCount + ')' : '') +
           (p.draftModel ? '+spec' : '');
  }).join(' → ') + '\n');
  process.stdout.write('[extract] concurrency=' + concurrency + '\n');
  if (dryRun) process.stdout.write('[extract] DRY RUN\n');

  // Adaptive delay between batches
  const baseDelay = opts['rate-limit'] ? parseInt(opts['rate-limit']) :
    chain[0]?.name === 'groq' && chain.length === 1 ? 1500 : // solo groq free: be conservative
    chain[0]?.name === 'groq' ? 800  :                        // groq with fallback
    chain[0]?.isOllama ? 0 :                                  // local: no delay
    200;

  for (let i = 0; i < chunks.length; i += concurrency) {
    const batch = chunks.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(async chunk => {
        if (shouldSkipChunk(chunk.text)) { skipped++; return []; }
        if (dryRun) {
          process.stdout.write('  [preview] "' + chunk.convName + '": would extract facts\n');
          return [];
        }
        const prompt = buildPrompt(chunk);
        const raw = await callWithFallback(prompt, chain, chunk.id);
        if (raw === null) { errors++; return []; } // all providers exhausted
        return parseExtracted(raw, chunk);
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled') { allFacts.push(...r.value); processed++; }
      else { errors++; process.stderr.write('[extract] error: ' + r.reason?.message + '\n'); }
    }

    const done = Math.min(i + concurrency, chunks.length);
    const activeName = chain.find(p => Date.now() >= (p.coolUntil || 0))?.name || 'cooling';
    process.stdout.write('\r[extract] ' + done + '/' + chunks.length +
      ' chunks — ' + allFacts.length + ' facts [' + activeName + ']    ');

    if (i + concurrency < chunks.length && baseDelay > 0) await sleep(baseDelay);
  }

  process.stdout.write('\n');
  process.stdout.write('[extract] done — ' + allFacts.length + ' facts from ' +
    processed + ' chunks (' + skipped + ' skipped, ' + errors + ' failed)\n');

  return allFacts;
}
