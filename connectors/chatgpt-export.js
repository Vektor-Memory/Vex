/**
 * connectors/chatgpt-export.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Vex source connector for ChatGPT (OpenAI) conversation exports.
 *
 * Input: conversations.json from ChatGPT data export (Settings → Data Controls
 *        → Export Data). The zip contains conversations.json.
 *
 * ChatGPT export shape:
 *   Array of conversations:
 *   {
 *     id:           string,
 *     title:        string,
 *     create_time:  number (unix timestamp),
 *     update_time:  number,
 *     mapping: {
 *       [nodeId]: {
 *         id:       string,
 *         parent:   string | null,
 *         children: string[],
 *         message: {
 *           id:          string,
 *           author:      { role: 'user' | 'assistant' | 'system' | 'tool' },
 *           create_time: number | null,
 *           content: {
 *             content_type: 'text' | 'tether_browsing_display' | ...,
 *             parts: (string | object)[]
 *           },
 *           status: string,
 *         } | null
 *       }
 *     },
 *     current_node: string   ← leaf of the active conversation thread
 *   }
 *
 * The mapping is a tree. To get the linear conversation we walk from
 * current_node → parent → parent → ... until root, then reverse.
 *
 * Chunking modes (--chunk-mode):
 *   turn          (default) — one record per message turn
 *   conversation  — one record per full conversation (concatenated)
 *   exchange      — one record per user+assistant adjacent pair
 *
 * Sender filter (--sender):
 *   both (default) | user | assistant
 *
 * Usage:
 *   vex export --from chatgpt-export --file conversations.json --output out.vmig.jsonl
 *   vex migrate --from chatgpt-export --to vektor \
 *               --file conversations.json --db memory.db
 *   vex export --from chatgpt-export --file conversations.json --output out.vmig.jsonl \
 *              --chunk-mode exchange --sender both --namespace chatgpt
 */

import fs from 'fs';
import { toRecord } from '../formats/vmig.js';
import { reEmbed }  from '../utils/embed.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function truncate(str, max = 120) {
  if (!str) return '';
  const s = str.replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/**
 * Extract plain text from a ChatGPT content object.
 * content.parts is an array of strings or objects (images, tether results, etc.)
 */
function extractText(content) {
  if (!content) return '';

  // Plain string (shouldn't happen but guard it)
  if (typeof content === 'string') return content.trim();

  // Standard content object with parts array
  if (Array.isArray(content.parts)) {
    return content.parts
      .map(p => {
        if (typeof p === 'string') return p;
        // Some parts are objects — extract text field if present
        if (p && typeof p === 'object') {
          return p.text || p.content || '';
        }
        return '';
      })
      .join('\n')
      .trim();
  }

  // Tether/browsing result — skip these, they're search result snippets
  if (content.content_type === 'tether_browsing_display') return '';
  if (content.content_type === 'tether_quote') return '';

  // Code output
  if (content.content_type === 'code' && content.text) return content.text;

  return '';
}

/**
 * Walk the mapping tree from current_node up to root, returning the
 * ordered linear message thread (root → leaf order).
 *
 * ChatGPT conversations are trees (branching when user edits a message),
 * so we follow the active branch via current_node.
 */
function extractThread(mapping, currentNodeId) {
  const path = [];
  let nodeId = currentNodeId;

  // Walk up to root
  const visited = new Set();
  while (nodeId && !visited.has(nodeId)) {
    visited.add(nodeId);
    const node = mapping[nodeId];
    if (!node) break;
    path.push(node);
    nodeId = node.parent;
  }

  // Reverse to get root → leaf order
  path.reverse();

  // Extract messages, skipping null/system/tool messages
  const messages = [];
  for (const node of path) {
    const msg = node.message;
    if (!msg) continue;
    if (!msg.author) continue;

    const role = msg.author.role;
    // Skip system, tool, and unknown roles
    if (role !== 'user' && role !== 'assistant') continue;

    const text = extractText(msg.content);
    if (!text) continue;

    // Unix timestamp → ISO string
    const created_at = msg.create_time
      ? new Date(msg.create_time * 1000).toISOString()
      : null;

    messages.push({
      id:         msg.id || node.id,
      role,
      text,
      created_at,
    });
  }

  return messages;
}

/**
 * Normalise ChatGPT export into consistent conversation array:
 * [{ id, name, created_at, messages: [{id, role, text, created_at}] }]
 */
function normaliseInput(raw) {
  const list = Array.isArray(raw) ? raw : null;

  if (!list) {
    throw new Error(
      '[chatgpt-export] Unrecognised input format. Expected top-level array of conversations.\n' +
      '  Make sure you are using the conversations.json file from ChatGPT data export.'
    );
  }

  const conversations = [];

  for (const conv of list) {
    // Must have a mapping object
    if (!conv.mapping || typeof conv.mapping !== 'object') {
      // Fallback: if it has a messages array (API format), handle it
      if (Array.isArray(conv.messages)) {
        const created_at = conv.create_time
          ? new Date(conv.create_time * 1000).toISOString()
          : null;
        conversations.push({
          id:         conv.id || crypto.randomUUID(),
          name:       conv.title || 'Untitled',
          created_at,
          messages:   conv.messages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => ({
              id:         m.id || crypto.randomUUID(),
              role:       m.role,
              text:       typeof m.content === 'string' ? m.content : (m.content?.text || ''),
              created_at: null,
            })),
        });
      }
      // else skip this conversation
      continue;
    }

    const currentNode = conv.current_node;
    if (!currentNode) continue;

    const messages = extractThread(conv.mapping, currentNode);
    if (!messages.length) continue;

    const created_at = conv.create_time
      ? new Date(conv.create_time * 1000).toISOString()
      : null;

    conversations.push({
      id:         conv.id || crypto.randomUUID(),
      name:       conv.title || 'Untitled',
      created_at,
      messages,
    });
  }

  return conversations;
}

// ── chunkers — identical pattern to claude-export ────────────────────────────

function chunkTurn(conv, senderFilter, namespace) {
  const records = [];
  for (const msg of conv.messages) {
    if (senderFilter !== 'both' && msg.role !== senderFilter) continue;
    if (!msg.text) continue;
    records.push(toRecord({
      id:         msg.id,
      text:       msg.text,
      vector:     null,
      namespace:  namespace || 'chatgpt-conversations',
      created_at: msg.created_at || conv.created_at || new Date().toISOString(),
      metadata: {
        role:              msg.role,
        conversation_id:   conv.id,
        conversation_name: truncate(conv.name, 80),
        source_format:     'chatgpt-export',
        chunk_mode:        'turn',
      },
    }, 'chatgpt-export'));
  }
  return records;
}

function chunkConversation(conv, senderFilter, namespace) {
  const parts = conv.messages
    .filter(m => (senderFilter === 'both' || m.role === senderFilter) && m.text)
    .map(m => `[${m.role.toUpperCase()}]\n${m.text}`);

  if (!parts.length) return [];

  return [toRecord({
    id:         conv.id,
    text:       parts.join('\n\n---\n\n'),
    vector:     null,
    namespace:  namespace || 'chatgpt-conversations',
    created_at: conv.created_at || new Date().toISOString(),
    metadata: {
      conversation_name: truncate(conv.name, 80),
      turn_count:        conv.messages.length,
      source_format:     'chatgpt-export',
      chunk_mode:        'conversation',
    },
  }, 'chatgpt-export')];
}

function chunkExchange(conv, senderFilter, namespace) {
  const records = [];
  const msgs    = conv.messages.filter(m => m.text);

  for (let i = 0; i < msgs.length - 1; i++) {
    const a = msgs[i];
    const b = msgs[i + 1];
    if (a.role !== 'user' || b.role !== 'assistant') continue;

    records.push(toRecord({
      id:         `${conv.id}:${a.id}`,
      text:       `[USER]\n${a.text}\n\n[ASSISTANT]\n${b.text}`,
      vector:     null,
      namespace:  namespace || 'chatgpt-conversations',
      created_at: a.created_at || conv.created_at || new Date().toISOString(),
      metadata: {
        conversation_id:   conv.id,
        conversation_name: truncate(conv.name, 80),
        user_message_id:   a.id,
        asst_message_id:   b.id,
        source_format:     'chatgpt-export',
        chunk_mode:        'exchange',
      },
    }, 'chatgpt-export'));
  }
  return records;
}

// ── connector ─────────────────────────────────────────────────────────────────

export const chatgptExportConnector = {
  name: 'chatgpt-export',

  async extract(opts) {
    const filePath   = opts['file'] || opts['from'] || opts['input'];
    const chunkMode  = (opts['chunk-mode'] || 'turn').toLowerCase();
    const senderRaw  = (opts['sender'] || 'both').toLowerCase();
    const namespace  = opts['namespace'] || null;
    const limitConvs = opts['limit-convs'] ? parseInt(opts['limit-convs']) : null;
    const limitMsgs  = opts['limit']       ? parseInt(opts['limit'])       : null;
    const afterDate  = opts['after']       ? new Date(opts['after'])       : null;
    const beforeDate = opts['before']      ? new Date(opts['before'])      : null;
    const convFilter = opts['conversation-name'] || null;

    if (!filePath) throw new Error('[chatgpt-export] --file <conversations.json> required');
    if (!fs.existsSync(filePath)) throw new Error(`[chatgpt-export] File not found: ${filePath}`);

    const validChunks  = ['turn', 'conversation', 'exchange'];
    const validSenders = ['both', 'user', 'assistant'];
    if (!validChunks.includes(chunkMode))
      throw new Error(`[chatgpt-export] --chunk-mode must be one of: ${validChunks.join(', ')}`);
    if (!validSenders.includes(senderRaw))
      throw new Error(`[chatgpt-export] --sender must be one of: both, user, assistant`);

    console.log(`[chatgpt-export] reading ${filePath}`);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      throw new Error(`[chatgpt-export] Failed to parse JSON: ${e.message}`);
    }

    let conversations = normaliseInput(raw);
    console.log(`[chatgpt-export] ${conversations.length} conversations found`);

    // ── filters ──────────────────────────────────────────────────────────────
    if (afterDate)   conversations = conversations.filter(c => c.created_at && new Date(c.created_at) >= afterDate);
    if (beforeDate)  conversations = conversations.filter(c => c.created_at && new Date(c.created_at) <= beforeDate);
    if (convFilter)  conversations = conversations.filter(c => (c.name || '').toLowerCase().includes(convFilter.toLowerCase()));
    if (limitConvs)  conversations = conversations.slice(0, limitConvs);

    console.log(`[chatgpt-export] ${conversations.length} conversations after filters — chunking mode: ${chunkMode}`);

    // ── chunk ─────────────────────────────────────────────────────────────────
    let records = [];
    for (const conv of conversations) {
      let chunk;
      if (chunkMode === 'conversation') chunk = chunkConversation(conv, senderRaw, namespace);
      else if (chunkMode === 'exchange') chunk = chunkExchange(conv, senderRaw, namespace);
      else                               chunk = chunkTurn(conv, senderRaw, namespace);
      records.push(...chunk);
    }

    if (limitMsgs) records = records.slice(0, limitMsgs);
    console.log(`[chatgpt-export] ${records.length} records produced`);

    // ── embed if requested ────────────────────────────────────────────────────
    const wantsEmbed = opts['embed-url'] || opts['openai-key'] || opts['ollama-url']
                    || process.env.OPENAI_API_KEY || opts['reembed'];

    if (wantsEmbed) {
      console.log('[chatgpt-export] embedding records...');
      if (opts['embed-url']) {
        await embedCustom(records, opts);
      } else {
        await reEmbed(records, { ...opts, 'force-reembed': true });
      }
      for (const r of records) {
        if (r.vector) r.dims = r.vector.length;
      }
    } else {
      console.log('[chatgpt-export] no embed provider set — vectors will be null (text-only import)');
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
};

// ── custom embed endpoint (--embed-url) ───────────────────────────────────────

async function embedCustom(records, opts) {
  const url    = opts['embed-url'];
  const model  = opts['embed-model'] || 'bge-small-en-v1.5';
  const apiKey = opts['embed-key'] || opts['openai-key'] || process.env.OPENAI_API_KEY || '';
  const BATCH  = 64;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let done = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    const texts = batch.map(r => r.text || '');

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body:   JSON.stringify({ model, input: texts }),
      });
    } catch (e) {
      throw new Error(`[chatgpt-export/embed] Network error calling ${url}: ${e.message}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`[chatgpt-export/embed] ${res.status} from ${url}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();

    let vectors;
    if (Array.isArray(data?.data)) {
      vectors = data.data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map(d => d.embedding);
    } else if (Array.isArray(data) && Array.isArray(data[0])) {
      vectors = data;
    } else if (Array.isArray(data?.embeddings)) {
      vectors = data.embeddings;
    } else {
      throw new Error(`[chatgpt-export/embed] Unrecognised embedding response shape from ${url}`);
    }

    for (let j = 0; j < batch.length; j++) {
      if (vectors[j]) {
        batch[j].vector = vectors[j];
        batch[j].model  = model;
      }
    }

    done += batch.length;
    process.stdout.write(`\r[chatgpt-export/embed] ${done}/${records.length} embedded`);
  }
  process.stdout.write('\n');
}
