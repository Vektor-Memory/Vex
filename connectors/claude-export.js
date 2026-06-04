/**
 * connectors/claude-export.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Vex source connector for Claude conversation exports.
 *
 * Supports two input shapes:
 *   • claude.ai export  — conversations.json  { uuid, name, chat_messages: [{uuid, sender, text, created_at}] }
 *   • API format        — array of { id, messages: [{role, content}] }
 *
 * Chunking modes (--chunk-mode):
 *   turn          (default) — one record per message turn
 *   conversation  — one record per full conversation (concatenated)
 *   exchange      — one record per human+assistant pair
 *
 * Sender filter (--sender):
 *   both (default) | human | assistant
 *
 * Embedding (--embed-url | --openai-key | --ollama-url):
 *   If any embed option is provided, records are embedded before export.
 *   Without embedding, vector is null — records are still valid vmig and
 *   work with BM25/FTS5 targets (VEKTOR) but not ANN targets (Pinecone, Qdrant).
 *
 * Usage:
 *   vex export --from claude-export --file conversations.json --output out.vmig.jsonl
 *   vex export --from claude-export --file conversations.json --output out.vmig.jsonl \
 *              --chunk-mode exchange --sender both --openai-key $KEY \
 *              --embed-model text-embedding-3-small --namespace claude
 *   vex migrate --from claude-export --to vektor \
 *              --file conversations.json --db memory.db
 */

import fs        from 'fs';
import { toRecord } from '../formats/vmig.js';
import { reEmbed }  from '../utils/embed.js';

// ── text helpers ─────────────────────────────────────────────────────────────

function truncate(str, max = 120) {
  if (!str) return '';
  const s = str.replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/**
 * Normalise a content value that may be a string, or an array of content
 * blocks (API format: [{type:'text', text:'...'}]).
 */
function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(b => b.type === 'text' || typeof b === 'string')
      .map(b => (typeof b === 'string' ? b : b.text || ''))
      .join('\n')
      .trim();
  }
  return String(content).trim();
}

// ── input normaliser ─────────────────────────────────────────────────────────

/**
 * Normalise either export format into a consistent array of conversations:
 * [{ id, name, created_at, messages: [{id, role, text, created_at}] }]
 */
function normaliseInput(raw) {
  // claude.ai export — top-level array or { conversations: [...] }
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.conversations)
      ? raw.conversations
      : null;

  if (!list) throw new Error('[claude-export] Unrecognised input format. Expected conversations array or {conversations:[...]}');

  return list.map(conv => {
    // claude.ai shape
    if (Array.isArray(conv.chat_messages)) {
      return {
        id:         conv.uuid || conv.id || crypto.randomUUID(),
        name:       conv.name || conv.title || 'Untitled',
        created_at: conv.created_at || conv.updated_at || null,
        messages:   conv.chat_messages.map(m => ({
          id:         m.uuid || m.id || crypto.randomUUID(),
          role:       m.sender === 'human' ? 'user' : 'assistant',
          text:       extractText(m.text || m.content),
          created_at: m.created_at || null,
        })),
      };
    }

    // API / OpenAI-style shape
    if (Array.isArray(conv.messages)) {
      return {
        id:         conv.id || crypto.randomUUID(),
        name:       conv.name || conv.title || 'Untitled',
        created_at: conv.created_at || null,
        messages:   conv.messages.map(m => ({
          id:         m.id || crypto.randomUUID(),
          role:       m.role === 'user' ? 'user' : 'assistant',
          text:       extractText(m.content),
          created_at: m.created_at || null,
        })),
      };
    }

    throw new Error(`[claude-export] Conversation ${conv.uuid || conv.id || '?'} has neither chat_messages nor messages array`);
  });
}

// ── chunkers ─────────────────────────────────────────────────────────────────

/**
 * turn — one vmig record per message
 */
function chunkTurn(conv, senderFilter, namespace) {
  const records = [];
  for (const msg of conv.messages) {
    if (senderFilter !== 'both' && msg.role !== senderFilter) continue;
    if (!msg.text) continue;
    records.push(toRecord({
      id:         msg.id,
      text:       msg.text,
      vector:     null,
      namespace:  namespace || 'claude-conversations',
      created_at: msg.created_at || conv.created_at || new Date().toISOString(),
      metadata: {
        role:              msg.role,
        conversation_id:   conv.id,
        conversation_name: truncate(conv.name, 80),
        source_format:     'claude-export',
        chunk_mode:        'turn',
      },
    }, 'claude-export'));
  }
  return records;
}

/**
 * conversation — one record per whole conversation (concatenated turns)
 */
function chunkConversation(conv, senderFilter, namespace) {
  const parts = conv.messages
    .filter(m => (senderFilter === 'both' || m.role === senderFilter) && m.text)
    .map(m => `[${m.role.toUpperCase()}]\n${m.text}`);

  if (!parts.length) return [];

  return [toRecord({
    id:         conv.id,
    text:       parts.join('\n\n---\n\n'),
    vector:     null,
    namespace:  namespace || 'claude-conversations',
    created_at: conv.created_at || new Date().toISOString(),
    metadata: {
      conversation_name: truncate(conv.name, 80),
      turn_count:        conv.messages.length,
      source_format:     'claude-export',
      chunk_mode:        'conversation',
    },
  }, 'claude-export')];
}

/**
 * exchange — one record per human+assistant adjacent pair
 */
function chunkExchange(conv, senderFilter, namespace) {
  const records = [];
  const msgs    = conv.messages.filter(m => m.text);

  for (let i = 0; i < msgs.length - 1; i++) {
    const a = msgs[i];
    const b = msgs[i + 1];
    if (a.role !== 'user' || b.role !== 'assistant') continue;

    // apply sender filter at exchange level
    if (senderFilter === 'human')    { /* still emit — exchange always has human */ }
    if (senderFilter === 'assistant') { /* still emit — exchange always has assistant */ }

    records.push(toRecord({
      id:         `${conv.id}:${a.id}`,
      text:       `[USER]\n${a.text}\n\n[ASSISTANT]\n${b.text}`,
      vector:     null,
      namespace:  namespace || 'claude-conversations',
      created_at: a.created_at || conv.created_at || new Date().toISOString(),
      metadata: {
        conversation_id:   conv.id,
        conversation_name: truncate(conv.name, 80),
        user_message_id:   a.id,
        asst_message_id:   b.id,
        source_format:     'claude-export',
        chunk_mode:        'exchange',
      },
    }, 'claude-export'));
  }
  return records;
}

// ── connector ─────────────────────────────────────────────────────────────────

export const claudeExportConnector = {
  name: 'claude-export',

  async extract(opts) {
    const filePath    = opts['file'] || opts['from'] || opts['input'];
    const chunkMode   = (opts['chunk-mode'] || 'turn').toLowerCase();
    const senderRaw   = (opts['sender'] || 'both').toLowerCase();
    const namespace   = opts['namespace'] || null;
    const limitConvs  = opts['limit-convs'] ? parseInt(opts['limit-convs']) : null;
    const limitMsgs   = opts['limit']       ? parseInt(opts['limit'])       : null;
    const afterDate   = opts['after']       ? new Date(opts['after'])       : null;
    const beforeDate  = opts['before']      ? new Date(opts['before'])      : null;
    const convFilter  = opts['conversation-name'] || null; // substring match

    if (!filePath) throw new Error('[claude-export] --file <conversations.json> required');
    if (!fs.existsSync(filePath)) throw new Error(`[claude-export] File not found: ${filePath}`);

    const validChunks  = ['turn', 'conversation', 'exchange'];
    const validSenders = ['both', 'human', 'user', 'assistant'];
    if (!validChunks.includes(chunkMode))
      throw new Error(`[claude-export] --chunk-mode must be one of: ${validChunks.join(', ')}`);
    if (!validSenders.includes(senderRaw))
      throw new Error(`[claude-export] --sender must be one of: both, human, assistant`);

    // normalise sender alias
    const sender = senderRaw === 'human' ? 'user' : senderRaw;

    console.log(`[claude-export] reading ${filePath}`);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      throw new Error(`[claude-export] Failed to parse JSON: ${e.message}`);
    }

    let conversations = normaliseInput(raw);
    console.log(`[claude-export] ${conversations.length} conversations found`);

    // ── filters ─────────────────────────────────────────────────────────────
    if (afterDate)    conversations = conversations.filter(c => c.created_at && new Date(c.created_at) >= afterDate);
    if (beforeDate)   conversations = conversations.filter(c => c.created_at && new Date(c.created_at) <= beforeDate);
    if (convFilter)   conversations = conversations.filter(c => (c.name || '').toLowerCase().includes(convFilter.toLowerCase()));
    if (limitConvs)   conversations = conversations.slice(0, limitConvs);

    console.log(`[claude-export] ${conversations.length} conversations after filters — chunking mode: ${chunkMode}`);

    // ── chunk ────────────────────────────────────────────────────────────────
    let records = [];
    for (const conv of conversations) {
      let chunk;
      if (chunkMode === 'conversation') chunk = chunkConversation(conv, sender, namespace);
      else if (chunkMode === 'exchange') chunk = chunkExchange(conv, sender, namespace);
      else                               chunk = chunkTurn(conv, sender, namespace);
      records.push(...chunk);
    }

    if (limitMsgs) records = records.slice(0, limitMsgs);
    console.log(`[claude-export] ${records.length} records produced`);

    // ── embed if requested ───────────────────────────────────────────────────
    const wantsEmbed = opts['embed-url'] || opts['openai-key'] || opts['ollama-url']
                    || process.env.OPENAI_API_KEY || opts['reembed'];

    if (wantsEmbed) {
      console.log('[claude-export] embedding records...');

      // If --embed-url is set, use a custom endpoint (VEKTOR or any OpenAI-compatible)
      if (opts['embed-url']) {
        await embedCustom(records, opts);
      } else {
        // delegate to shared reEmbed utility (OpenAI / Ollama)
        // mark all records as needing embed
        await reEmbed(records, { ...opts, 'force-reembed': true });
      }

      // update dims on each record
      for (const r of records) {
        if (r.vector) r.dims = r.vector.length;
      }
    } else {
      console.log('[claude-export] no embed provider set — vectors will be null (text-only import)');
    }

    return records;
  },

  async extractStream(opts, onPage) {
    const records = await this.extract(opts);
    const PAGE    = 1000;
    for (let i = 0; i < records.length; i += PAGE) {
      await onPage(records.slice(i, i + PAGE));
    }
  },

  // claude-export is source-only — no load() needed
  // (import target is handled by vektor/qdrant/pinecone connectors)
};

// ── custom embed endpoint (--embed-url) ──────────────────────────────────────

async function embedCustom(records, opts) {
  const url     = opts['embed-url'];
  const model   = opts['embed-model'] || 'bge-small-en-v1.5';
  const apiKey  = opts['embed-key']   || opts['openai-key'] || process.env.OPENAI_API_KEY || '';
  const BATCH   = 64;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let done = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    const texts = batch.map(r => r.text || '');

    let res;
    try {
      res = await fetch(url, {
        method:  'POST',
        headers,
        body:    JSON.stringify({ model, input: texts }),
      });
    } catch (e) {
      throw new Error(`[claude-export/embed] Network error calling ${url}: ${e.message}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`[claude-export/embed] ${res.status} from ${url}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();

    // Accept both OpenAI shape { data:[{embedding}] } and plain [[...floats]]
    let vectors;
    if (Array.isArray(data?.data)) {
      vectors = data.data
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map(d => d.embedding);
    } else if (Array.isArray(data) && Array.isArray(data[0])) {
      vectors = data;
    } else if (Array.isArray(data?.embeddings)) {
      vectors = data.embeddings;
    } else {
      throw new Error(`[claude-export/embed] Unrecognised embedding response shape from ${url}`);
    }

    for (let j = 0; j < batch.length; j++) {
      if (vectors[j]) {
        batch[j].vector = vectors[j];
        batch[j].model  = model;
      }
    }

    done += batch.length;
    process.stdout.write(`\r[claude-export/embed] ${done}/${records.length} embedded`);
  }
  process.stdout.write('\n');
}
