/**
 * adapters/convert/index.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Format adapters for `vex convert` — transform .vmig.jsonl conversation
 * records into provider-specific formats for fine-tuning or context injection.
 *
 * Each adapter exposes:
 *   convert(records, opts)  → string  (the output file content)
 *   fileExtension           → string  (e.g. 'jsonl', 'json', 'txt')
 *   description             → string  (shown in help)
 *
 * Records are assumed to have been produced by the claude-export connector.
 * metadata.role, metadata.conversation_id, and text are the key fields.
 */

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Group records by conversation_id, preserving order.
 * Returns [{ convId, name, messages: [{role, text, created_at}] }]
 */
function groupByConversation(records) {
  const map = new Map();
  for (const r of records) {
    const convId = r.metadata?.conversation_id || r.id;
    const name   = r.metadata?.conversation_name || 'Untitled';
    if (!map.has(convId)) map.set(convId, { convId, name, messages: [] });
    map.get(convId).messages.push({
      role:       r.metadata?.role || 'user',
      text:       r.text || '',
      created_at: r.created_at,
      id:         r.id,
    });
  }
  return [...map.values()];
}

/**
 * Normalise role to OpenAI convention: user | assistant | system
 */
function normRole(role) {
  if (role === 'human' || role === 'user') return 'user';
  if (role === 'assistant')                return 'assistant';
  return 'user';
}

// ── OpenAI fine-tune adapter ──────────────────────────────────────────────────

export const openaiFinetune = {
  name:        'openai-finetune',
  fileExtension: 'jsonl',
  description:  'OpenAI fine-tuning JSONL — one conversation per line ({messages:[{role,content}]}). Upload to POST /v1/files then /v1/fine_tuning/jobs.',

  convert(records, opts) {
    const systemPrompt = opts['system-prompt'] || null;
    const convs = groupByConversation(records);
    const lines = [];

    for (const conv of convs) {
      const messages = [];

      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }

      for (const msg of conv.messages) {
        if (!msg.text) continue;
        messages.push({ role: normRole(msg.role), content: msg.text });
      }

      // OpenAI fine-tune requires at least one user + one assistant turn
      const hasUser = messages.some(m => m.role === 'user');
      const hasAsst = messages.some(m => m.role === 'assistant');
      if (!hasUser || !hasAsst) continue;

      lines.push(JSON.stringify({ messages }));
    }

    return lines.join('\n') + '\n';
  },
};

// ── OpenAI context injection adapter ─────────────────────────────────────────

export const openaiContext = {
  name:        'openai-context',
  fileExtension: 'json',
  description:  'OpenAI chat completion context — messages array ready for POST /v1/chat/completions. Use to continue a conversation in GPT-4o.',

  convert(records, opts) {
    const systemPrompt  = opts['system-prompt'] || 'You are a helpful assistant. The following is prior conversation history.';
    const maxTokensHint = opts['max-tokens']    ? parseInt(opts['max-tokens']) : null;
    const convId        = opts['conversation-id'] || null;

    let filtered = records;
    if (convId) filtered = records.filter(r => r.metadata?.conversation_id === convId);

    // Rough token estimate: 1 token ≈ 4 chars
    let messages = [{ role: 'system', content: systemPrompt }];
    let charBudget = maxTokensHint ? maxTokensHint * 4 : Infinity;
    charBudget -= systemPrompt.length;

    for (const r of filtered) {
      if (!r.text) continue;
      if (charBudget <= 0) break;
      messages.push({ role: normRole(r.metadata?.role || 'user'), content: r.text });
      charBudget -= r.text.length;
    }

    return JSON.stringify({ messages }, null, 2) + '\n';
  },
};

// ── Generic chat adapter (Perplexity, Groq, Mistral, Together, Cohere, etc.) ─

export const genericChat = {
  name:        'generic-chat',
  fileExtension: 'jsonl',
  description:  'Generic OpenAI-compatible {role,content} JSONL. Works with Perplexity, Groq, Together AI, Mistral, Cohere, Fireworks, Cerebras — any provider accepting the OpenAI chat format.',

  convert(records, opts) {
    const systemPrompt = opts['system-prompt'] || null;
    const convs = groupByConversation(records);
    const lines = [];

    for (const conv of convs) {
      const messages = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });

      for (const msg of conv.messages) {
        if (!msg.text) continue;
        messages.push({ role: normRole(msg.role), content: msg.text });
      }

      if (messages.filter(m => m.role !== 'system').length < 1) continue;

      lines.push(JSON.stringify({
        messages,
        _meta: { conversation_id: conv.convId, conversation_name: conv.name },
      }));
    }

    return lines.join('\n') + '\n';
  },
};

// ── Anthropic fine-tune adapter ───────────────────────────────────────────────
// Anthropic fine-tuning format (when available) mirrors the Messages API.

export const anthropicFinetune = {
  name:        'anthropic-finetune',
  fileExtension: 'jsonl',
  description:  'Anthropic Messages API format JSONL — ready for fine-tuning when Anthropic fine-tuning becomes available. Also usable as conversation history for the Messages API.',

  convert(records, opts) {
    const systemPrompt = opts['system-prompt'] || null;
    const convs = groupByConversation(records);
    const lines = [];

    for (const conv of convs) {
      const messages = [];

      for (const msg of conv.messages) {
        if (!msg.text) continue;
        const role = normRole(msg.role);
        // Anthropic alternates user/assistant strictly — merge consecutive same-role messages
        if (messages.length && messages[messages.length - 1].role === role) {
          messages[messages.length - 1].content += '\n\n' + msg.text;
        } else {
          messages.push({ role, content: msg.text });
        }
      }

      // Must start with user
      if (!messages.length || messages[0].role !== 'user') continue;

      const record = { messages };
      if (systemPrompt) record.system = systemPrompt;

      lines.push(JSON.stringify(record));
    }

    return lines.join('\n') + '\n';
  },
};

// ── Plain text transcript adapter ─────────────────────────────────────────────

export const plainText = {
  name:        'plain-text',
  fileExtension: 'txt',
  description:  'Human-readable transcript. One conversation per block, roles labelled. Useful for manual review, summarisation pipelines, or feeding into context windows without JSON parsing.',

  convert(records, opts) {
    const separator = opts['separator'] || '═'.repeat(72);
    const convs     = groupByConversation(records);
    const blocks    = [];

    for (const conv of convs) {
      const lines = [`${separator}`, `CONVERSATION: ${conv.name}`, `ID: ${conv.convId}`, ''];
      for (const msg of conv.messages) {
        if (!msg.text) continue;
        const label = msg.role === 'user' ? 'HUMAN' : 'ASSISTANT';
        lines.push(`[${label}]`);
        lines.push(msg.text);
        lines.push('');
      }
      blocks.push(lines.join('\n'));
    }

    return blocks.join('\n') + '\n';
  },
};

// ── Adapter registry ──────────────────────────────────────────────────────────

const ADAPTERS = {
  'openai-finetune':   openaiFinetune,
  'openai-context':    openaiContext,
  'generic-chat':      genericChat,
  'perplexity':        genericChat,   // alias — same format
  'groq':              genericChat,   // alias
  'mistral':           genericChat,   // alias
  'together':          genericChat,   // alias
  'anthropic-finetune':anthropicFinetune,
  'anthropic':         anthropicFinetune, // alias
  'plain-text':        plainText,
  'txt':               plainText,     // alias
};

export function getAdapter(name) {
  const a = ADAPTERS[name?.toLowerCase()];
  if (!a) throw new Error(
    `Unknown convert adapter: "${name}". Available: ${[...new Set(Object.keys(ADAPTERS))].join(', ')}`
  );
  return a;
}

export function listConvertAdapters() {
  const seen = new Set();
  return Object.entries(ADAPTERS)
    .filter(([k, v]) => { if (seen.has(v.name)) return false; seen.add(v.name); return true; })
    .map(([, v]) => ({ name: v.name, ext: v.fileExtension, description: v.description }));
}
