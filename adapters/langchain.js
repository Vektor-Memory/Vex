/**
 * vex/adapters/langchain.js
 * ──────────────────────────
 * Drop-in LangChain memory adapter backed by VEKTOR Slipstream.
 *
 * Usage (LangChain JS / TypeScript):
 *
 *   import { VektorMemory } from '@vektormemory/vex/adapters/langchain.js';
 *   import { createMemory } from 'vektor-slipstream';
 *
 *   const memory = await createMemory({ dbPath: './agent.db' });
 *   const vektorMem = new VektorMemory({ memory, topK: 5 });
 *
 *   const chain = new ConversationChain({ llm, memory: vektorMem });
 *
 * Standalone (without LangChain chain — just inject context manually):
 *
 *   const ctx = await vektorMem.loadMemoryVariables({ input: 'what is our auth setup?' });
 *   console.log(ctx.history); // top-5 relevant memories as formatted string
 *
 *   await vektorMem.saveContext(
 *     { input: 'what is our auth setup?' },
 *     { output: 'We use JWT with RS256...' }
 *   );
 *
 * Peer dependencies:
 *   @langchain/core (optional — works without it for standalone use)
 *   vektor-slipstream
 *
 * memory_type tagging:
 *   Conversations saved via saveContext() are tagged 'episodic'.
 *   Pass opts.memory_type to override: vektorMem.saveContext(i, o, { memory_type: 'semantic' })
 */

// ── BaseMemory shim ───────────────────────────────────────────────────────────
// We implement the same interface as LangChain's BaseMemory without requiring
// @langchain/core as a hard dependency. If it's installed, VektorMemory will
// be a proper subclass. If not, it still works as a standalone duck-typed class.

let BaseMemory;
try {
  const lc = await import('@langchain/core/memory');
  BaseMemory = lc.BaseMemory;
} catch {
  // Fallback: plain class — implements the same interface
  BaseMemory = class BaseMemory {
    get memoryKeys() { return []; }
    async loadMemoryVariables(_inputs) { return {}; }
    async saveContext(_inputs, _outputs) {}
    async clear() {}
  };
}

// ── VektorMemory ──────────────────────────────────────────────────────────────

export class VektorMemory extends BaseMemory {
  /**
   * @param {object} opts
   * @param {object}  opts.memory         - VEKTOR memory instance (from createMemory())
   * @param {number}  opts.topK           - memories to inject per turn (default: 5)
   * @param {string}  opts.inputKey       - key to read from chain input (default: 'input')
   * @param {string}  opts.outputKey      - key to read from chain output (default: 'output')
   * @param {string}  opts.memoryKey      - key to write into chain memory vars (default: 'history')
   * @param {boolean} opts.returnMessages - return as ChatMessage array (default: false, returns string)
   * @param {number}  opts.minScore       - min similarity score to include (default: 0.0)
   * @param {string}  opts.prefix         - prefix injected before memory context (default: '[MEMORY]\n')
   * @param {boolean} opts.includeScores  - include similarity scores in output (default: false)
   * @param {number}  opts.importance     - importance score for saved turns (default: 3)
   */
  constructor(opts = {}) {
    super();

    if (!opts.memory) throw new Error('[VektorMemory] opts.memory (VEKTOR memory instance) is required');

    this._memory        = opts.memory;
    this._topK          = opts.topK          ?? 5;
    this._inputKey      = opts.inputKey      ?? 'input';
    this._outputKey     = opts.outputKey     ?? 'output';
    this._memoryKey     = opts.memoryKey     ?? 'history';
    this._returnMessages= opts.returnMessages ?? false;
    this._minScore      = opts.minScore      ?? 0.0;
    this._prefix        = opts.prefix        ?? '[VEKTOR MEMORY]\n';
    this._includeScores = opts.includeScores ?? false;
    this._importance    = opts.importance    ?? 3;
  }

  // LangChain interface — declares which keys this memory writes
  get memoryKeys() {
    return [this._memoryKey];
  }

  /**
   * Called before each LLM turn. Recalls relevant memories and returns
   * them as context to inject into the prompt.
   */
  async loadMemoryVariables(inputs) {
    const query = inputs[this._inputKey] || inputs.input || Object.values(inputs)[0] || '';
    if (!query) return { [this._memoryKey]: '' };

    let results = [];
    try {
      results = await this._memory.recall(query, this._topK);
    } catch (e) {
      console.warn(`[VektorMemory] recall failed: ${e.message}`);
      return { [this._memoryKey]: '' };
    }

    // Filter by minimum score
    const filtered = this._minScore > 0
      ? results.filter(r => (r.score ?? 1) >= this._minScore)
      : results;

    if (!filtered.length) return { [this._memoryKey]: '' };

    if (this._returnMessages) {
      // Return as array of {role, content} for chat models
      const messages = filtered.map(r => ({
        role:    'system',
        content: r.content || r.text || '',
      }));
      return { [this._memoryKey]: messages };
    }

    // Return as formatted string
    const lines = filtered.map((r, i) => {
      const score = this._includeScores && r.score != null
        ? ` (score: ${r.score.toFixed(3)})`
        : '';
      const type = r.memory_type ? ` [${r.memory_type}]` : '';
      return `${i + 1}.${type}${score} ${r.content || r.text || ''}`;
    });

    const context = this._prefix + lines.join('\n');
    return { [this._memoryKey]: context };
  }

  /**
   * Called after each LLM turn. Stores the input/output exchange as memory.
   *
   * @param {object} inputs   - chain input values
   * @param {object} outputs  - chain output values
   * @param {object} opts     - override memory_type, importance, tags
   */
  async saveContext(inputs, outputs, opts = {}) {
    const input  = inputs[this._inputKey]   || inputs.input   || '';
    const output = outputs[this._outputKey] || outputs.output || outputs.text || '';

    if (!input && !output) return;

    const memType   = opts.memory_type ?? 'episodic';
    const importance= opts.importance  ?? this._importance;
    const tags      = opts.tags        ?? ['_langchain'];

    try {
      // Store as a combined turn
      const turn = `Human: ${input}\nAI: ${output}`;
      await this._memory.remember(turn, {
        importance,
        tags,
        memory_type: memType,
      });

      // Optionally store input alone at higher importance if it contains a question/fact
      const isQuestion = input.includes('?') || /what|how|when|where|who|why/i.test(input);
      if (isQuestion && input.length > 20) {
        await this._memory.remember(input, {
          importance: Math.min(5, importance + 1),
          tags:       [...tags, '_question'],
          memory_type: 'working',
        });
      }
    } catch (e) {
      console.warn(`[VektorMemory] saveContext failed: ${e.message}`);
    }
  }

  /**
   * Clear all memories (use with caution — deletes the entire namespace).
   * Pass { confirm: true } to actually execute.
   */
  async clear(opts = {}) {
    if (!opts.confirm) {
      console.warn('[VektorMemory] clear() called without { confirm: true } — skipped');
      return;
    }
    try {
      if (typeof this._memory.forgetWhere === 'function') {
        await this._memory.forgetWhere('', { all: true });
      }
    } catch (e) {
      console.warn(`[VektorMemory] clear failed: ${e.message}`);
    }
  }

  // ── Convenience methods (not part of LangChain interface) ─────────────────

  /** Direct recall — useful for testing or custom context assembly */
  async recall(query, topK) {
    return this._memory.recall(query, topK ?? this._topK);
  }

  /** Direct store with memory_type */
  async remember(text, opts = {}) {
    return this._memory.remember(text, opts);
  }

  /** Get raw VEKTOR memory instance */
  get vektorInstance() {
    return this._memory;
  }
}

// ── Factory helper ────────────────────────────────────────────────────────────

/**
 * Create a VektorMemory instance from a DB path (no need to call createMemory() yourself).
 *
 * @param {object} opts
 * @param {string}  opts.dbPath  - path to VEKTOR SQLite DB
 * @param {object}  opts.memory  - pass existing memory instance instead of dbPath
 * @param {object}  rest         - passed through to VektorMemory constructor
 */
export async function createVektorMemory(opts = {}) {
  let memory = opts.memory;

  if (!memory) {
    if (!opts.dbPath) throw new Error('[createVektorMemory] opts.dbPath or opts.memory required');
    try {
      const { createMemory } = await import('vektor-slipstream');
      memory = await createMemory({ dbPath: opts.dbPath, namespace: opts.namespace });
    } catch {
      throw new Error(
        '[createVektorMemory] vektor-slipstream not found.\n' +
        '  Install: npm install vektor-slipstream'
      );
    }
  }

  const { dbPath: _, memory: __, ...rest } = opts;
  return new VektorMemory({ memory, ...rest });
}
