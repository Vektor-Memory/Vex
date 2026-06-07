/**
 * pipeline/01-chunk.js — conversation chunking
 * Splits raw conversations into processable units.
 * Modes: turn | conversation | exchange | smart
 * smart = exchange for short convs (<20 turns), conversation for long ones
 */

export function chunkConversations(conversations, opts = {}) {
  const mode   = (opts.mode || 'conversation').toLowerCase();
  const sender = (opts.sender || 'both').toLowerCase();
  const maxChars = opts.maxChars || null;
  const results = [];

  for (const conv of conversations) {
    const msgs = (conv.messages || []).filter(m => m.text && m.text.trim());
    if (!msgs.length) continue;

    const effectiveMode = mode === 'smart'
      ? (msgs.length < 20 ? 'exchange' : 'conversation')
      : mode;

    if (effectiveMode === 'turn') {
      for (const m of msgs) {
        if (sender !== 'both' && m.role !== sender) continue;
        results.push({
          id: m.id || (conv.id + ':' + m.role + ':' + results.length),
          convId: conv.id,
          convName: conv.name || 'Untitled',
          text: m.text,
          role: m.role,
          created_at: m.created_at || conv.created_at,
          chunkMode: 'turn',
          turnCount: 1,
        });
      }
    } else if (effectiveMode === 'exchange') {
      for (let i = 0; i < msgs.length - 1; i++) {
        const a = msgs[i], b = msgs[i+1];
        if (a.role !== 'user' || b.role !== 'assistant') continue;
        results.push({
          id: conv.id + ':ex:' + i,
          convId: conv.id,
          convName: conv.name || 'Untitled',
          text: '[USER]\n' + a.text + '\n\n[ASSISTANT]\n' + b.text,
          role: 'exchange',
          created_at: a.created_at || conv.created_at,
          chunkMode: 'exchange',
          turnCount: 2,
        });
      }
    } else {
      // conversation mode — one chunk (or split if maxChars)
      const filtered = msgs.filter(m => sender === 'both' || m.role === sender);
      if (!filtered.length) continue;
      const fullText = filtered.map(m => '[' + m.role.toUpperCase() + ']\n' + m.text).join('\n\n---\n\n');

      if (!maxChars || fullText.length <= maxChars) {
        results.push({
          id: conv.id,
          convId: conv.id,
          convName: conv.name || 'Untitled',
          text: fullText,
          role: 'conversation',
          created_at: conv.created_at,
          chunkMode: 'conversation',
          turnCount: filtered.length,
        });
      } else {
        let remaining = fullText, part = 1;
        while (remaining.length > 0) {
          let chunk;
          if (remaining.length <= maxChars) { chunk = remaining; remaining = ''; }
          else {
            const boundary = remaining.lastIndexOf('\n\n---\n\n', maxChars);
            const cutAt = boundary > maxChars * 0.5 ? boundary : maxChars;
            chunk = remaining.slice(0, cutAt);
            remaining = remaining.slice(cutAt).replace(/^\s*---\s*\n/, '').trimStart();
          }
          results.push({
            id: part === 1 ? conv.id : conv.id + ':p' + part,
            convId: conv.id,
            convName: conv.name || 'Untitled',
            text: chunk,
            role: 'conversation',
            created_at: conv.created_at,
            chunkMode: 'conversation',
            turnCount: filtered.length,
            part, totalParts: Math.ceil(fullText.length / maxChars),
          });
          part++;
        }
      }
    }
  }
  return results;
}
