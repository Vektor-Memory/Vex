# Vex — Vector Exchange v0.6.2

> Cross-standard vector DB migration tool with cryptographic memory portability. Export, sign, verify, and migrate agent memory between vector stores using the open `.vmig.jsonl` interchange format.

https://medium.com/ai-in-plain-english/your-agent-memory-is-trapped-heres-the-key-87224b483534
<img width="720" height="514" alt="image" src="https://github.com/user-attachments/assets/cac0e561-7fae-4853-9c9f-9960a78d6f2f" />



<img width="1073" height="467" alt="image" src="https://github.com/user-attachments/assets/8ac8b77a-289b-4dbd-a75b-239f14942498" />



```bash
npx @vektormemory/vex export --from vektor --db slipstream-memory.db --output memories.vmig.jsonl
npx @vektormemory/vex sign memories.vmig.jsonl
npx @vektormemory/vex verify memories.vmig.jsonl
npx @vektormemory/vex import --from memories.vmig.jsonl --to pinecone --api-key $KEY --index my-index --host $HOST
npx @vektormemory/vex migrate --from vektor --to qdrant --db memory.db --url http://localhost:6333 --collection memories
```

# Why

Every vector DB has a different API, a different format, and zero interop. Every LLM platform locks your conversation history behind a proprietary export. Moving your agent memory between systems means writing a one-off script every time.

`vex` fixes that with a single open format, a growing connector library, and a set of format adapters that turn your conversation history into whatever shape any LLM provider needs. Your memory is always exportable, always portable, always verifiable, always yours.

---

# What's New in v0.6.2
### Added
- **`core/graph-builder.js`** — post-import MAGMA graph engine. After any `vex load --to vektor`, the builder automatically reconstructs three structural edge layers from flat imported records: `temporal` (chronological chain within a configurable time window), `tag:*` (nodes sharing a tag, 2–50 member groups only), and `causal` (supersession edges detected from content patterns). All writes use INSERT OR IGNORE so re-runs are safe. Exposed as `buildGraph(db, rows, opts)` for direct use by any connector writing to a Slipstream DB.
- **`vektor` connector `load()`** — full write implementation replacing the v0.1 stub. Writes memory rows with correct `agent_id` (from `--agent-id` flag or `VEKTOR_AGENT_ID` env), `namespace`, `created_at`, and Float32 vector blobs. Batched transactions with progress output. Calls `buildGraph()` automatically unless `--skip-graph` is passed. Resolves `better-sqlite3` from the vektor-slipstream bundled path first, then falls back to global install.
- **Retroactive graph backfill** — running `vex graph-build --db <path>` (or the graph builder directly) against an existing DB will generate edges for all rows including pre-existing vex imports that had none.

**Conversation portability.** Import your entire Claude or ChatGPT history into any vector DB in one command. Convert it to OpenAI fine-tuning format, Anthropic Messages API, Groq, Perplexity, Mistral, or plain text. Your conversations are now first-class agent memory.
- **`claude-export` connector** — import from the official claude.ai data export. Handles both claude.ai and API shapes. Three chunking modes: `turn`, `conversation`, `exchange`.
- **`chatgpt-export` connector** — import from the official ChatGPT data export. Reconstructs the active conversation thread from ChatGPT's tree-structured mapping format.
- **`vex convert` command** — transform `.vmig.jsonl` into provider-specific formats for fine-tuning or context injection. Five adapters: `openai-finetune`, `openai-context`, `generic-chat`, `anthropic-finetune`, `plain-text`.
- **Schema-adaptive `vektor` connector** — `load()` now detects the target DB's column names, primary key type, and schema version at runtime. Works with any VEKTOR DB — minimal, full SDK, integer ID, TEXT ID — without modification.
- **Accurate import counters** — summary numbers now come from the connector's own upserted/skipped counts, not a vector-presence heuristic. Text-only imports (no vectors) show the correct count.

---

# Connectors

| Connector | Export | Import | Notes |
|-----------|--------|--------|-------|
| `vektor` | ✅ | ✅ | VEKTOR Slipstream SQLite — schema-adaptive, sqlite-vec ANN optional |
| `jsonl` | ✅ | ✅ | `.vmig.jsonl` round-trip |
| `pinecone` | ✅ | ✅ | Tested 4,900 vectors |
| `qdrant` | ✅ | ✅ | Tested 3,917 vectors, auto-create collection |
| `chroma` | ✅ | ✅ | Auto-create collection |
| `weaviate` | ✅ | ✅ | GraphQL cursor pagination, extractStream |
| `pgvector` | ✅ | ✅ | Schema introspection, extractStream |
| `claude-export` | ✅ | — | Claude conversation JSON → vmig |
| `chatgpt-export` | ✅ | — | ChatGPT conversation JSON → vmig |

---

# Convert Adapters

| Adapter | Output | Use |
|---------|--------|-----|
| `openai-finetune` | `.jsonl` | Upload to `POST /v1/files` → `/v1/fine_tuning/jobs` |
| `openai-context` | `.json` | Inject as context into any chat completion call |
| `generic-chat` | `.jsonl` | Perplexity, Groq, Mistral, Together, Fireworks, Cerebras |
| `anthropic-finetune` | `.jsonl` | Anthropic Messages API format |
| `plain-text` | `.txt` | Human-readable transcript |

Aliases: `perplexity` / `groq` / `mistral` / `together` → `generic-chat` · `anthropic` → `anthropic-finetune` · `txt` → `plain-text`

---

# Install

```bash
npm install -g @vektormemory/vex

# Or run without installing
npx @vektormemory/vex --help

# Signing support (BLAKE3 + Ed25519)
npm install @noble/hashes @noble/ed25519

# Vex Adapter (vec2vec projection — optional, premium)
npm install @vektormemory/vex-adapter
```

Requirements: Node.js >= 18. No extra dependencies for Pinecone, Qdrant, Chroma, or Weaviate — connectors use the built-in fetch API. pgvector requires `npm install pg`.

---

## [0.6.1] - 2026-06-05

### Fixed
- vektor connector: FTS5 triggers with TEXT id as rowid caused datatype mismatch on import into Slipstream DBs with v1.5+ schema. Triggers suspended before bulk import and rebuilt after.
- vektor connector: created_at normalised to unix timestamp when target schema uses NUM column.

# Commands

## Conversation Export (v0.6.1)

```bash
# Claude — export from claude.ai Settings → Privacy → Export Data
vex export --from claude-export --file conversations.json --output claude.vmig.jsonl

# ChatGPT — export from Settings → Data Controls → Export Data
vex export --from chatgpt-export --file conversations.json --output chatgpt.vmig.jsonl

# Migrate directly into VEKTOR DB (no intermediate file)
vex migrate --from claude-export --to vektor \
  --file conversations.json --db memory.db

# With chunking + embedding
vex export --from claude-export --file conversations.json --output out.vmig.jsonl \
  --chunk-mode exchange \
  --sender both \
  --namespace claude \
  --after 2025-01-01 \
  --openai-key $OPENAI_API_KEY

# Chunking modes:
#   turn         — one record per message (best for semantic search)
#   conversation — one record per full conversation (best for summarisation)
#   exchange     — one record per user+assistant pair (best for fine-tuning)
```

## Convert — LLM Provider Formats (v0.6.1)

```bash
# List all adapters
vex convert --adapter list

# → OpenAI fine-tuning
vex convert --from claude.vmig.jsonl --adapter openai-finetune --output finetune.jsonl

# → OpenAI context injection (continue a conversation in GPT-4o)
vex convert --from claude.vmig.jsonl --adapter openai-context --output context.json

# → Perplexity / Groq / Mistral / Together
vex convert --from claude.vmig.jsonl --adapter generic-chat --output chat.jsonl

# → Anthropic Messages API
vex convert --from claude.vmig.jsonl --adapter anthropic-finetune --output anthropic.jsonl

# → Plain text transcript
vex convert --from claude.vmig.jsonl --adapter plain-text --output transcripts.txt

# With system prompt
vex convert --from claude.vmig.jsonl --adapter openai-finetune \
  --system-prompt "You are an expert AI memory systems engineer." \
  --output finetune.jsonl
```

## Sign & Verify (v0.4.0)

```bash
# Sign an export — generates .vmig.sig + .vmig.key
vex sign memories.vmig.jsonl

# Verify integrity (exit 0 = valid, exit 1 = tampered)
vex verify memories.vmig.jsonl

# Pipeline: verify before import
vex verify memories.vmig.jsonl && vex import --from memories.vmig.jsonl --to qdrant --collection mem

# Export + auto-sign in one step
vex export --from vektor --db memory.db --output memories.vmig.jsonl --sign
```

## Selective Disclosure (v0.4.0)

```bash
# Export only working memory (current goals, TODOs, status)
vex export --from vektor --db memory.db --components working --output todos.vmig.jsonl

# Export working + procedural (skills + state) for a coding agent
vex export --from vektor --db memory.db --components working,procedural --output coding-ctx.vmig.jsonl
```

Memory types: `episodic` · `semantic` · `procedural` · `working` · `identity`

## Export — Vector Stores

```bash
vex export --from vektor --db ./slipstream-memory.db --output memories.vmig.jsonl
vex export --from qdrant --url http://localhost:6333 --collection memories --output memories.vmig.jsonl
vex export --from pinecone --api-key $KEY --index my-index --host $HOST --output memories.vmig.jsonl
vex export --from chroma --collection memories --output memories.vmig.jsonl
vex export --from weaviate --url http://localhost:8080 --collection MyDocs --output memories.vmig.jsonl
vex export --from pgvector --url postgres://user:pass@host/db --output memories.vmig.jsonl
```

## Import

```bash
vex import --from memories.vmig.jsonl --to vektor --db ./target.db
vex import --from memories.vmig.jsonl --to pinecone --api-key $KEY --index my-index --host $HOST
vex import --from memories.vmig.jsonl --to qdrant --url http://localhost:6333 --collection memories
vex import --from memories.vmig.jsonl --to chroma --collection memories
vex import --from memories.vmig.jsonl --to pgvector --url postgres://user:pass@host/db
```

## Migrate (direct)

```bash
vex migrate --from vektor --to qdrant --db ./memory.db --url http://localhost:6333 --collection memories
vex migrate --from vektor --to pgvector --db ./memory.db --url postgres://user:pass@host/db
vex migrate --from claude-export --to vektor --file conversations.json --db memory.db
```

## Embedding Flags

```bash
# Re-embed via OpenAI
vex migrate --from vektor --to qdrant --db memory.db --collection memories \
  --reembed --embed-model text-embedding-3-small

# Re-embed via Ollama (local)
vex migrate --from vektor --to qdrant --db memory.db --collection memories \
  --reembed --embed-model nomic-embed-text --ollama-url http://localhost:11434

# vec2vec projection — no API call (premium)
vex migrate --from memories.vmig.jsonl --to pinecone \
  --adapter --adapter-model text-embedding-3-small
```

---

# LangChain Adapter (v0.4.0)

```js
import { createVektorMemory } from '@vektormemory/vex/adapters/langchain';
import { ConversationChain } from 'langchain/chains';

const vektorMem = await createVektorMemory({
  dbPath: './agent.db',
  topK: 5,
  importance: 3,
});

const chain = new ConversationChain({ llm, memory: vektorMem });
await chain.call({ input: 'What is our auth setup?' });
```

---

# .vmig.jsonl Format

One JSON object per line. UTF-8. Portable across any vector store or LLM provider.

```json
{
  "id": "019da9a0-eff2-71d0-ba1a-f03fb8f88b4f",
  "text": "How do I configure VEKTOR with Claude Desktop?",
  "vector": [0.021, -0.043, 0.018, "...384 or 768 floats"],
  "model": "text-embedding-3-small",
  "dims": 1536,
  "namespace": "claude-conversations",
  "metadata": {
    "role": "user",
    "conversation_id": "abc123",
    "conversation_name": "VEKTOR setup session",
    "source_format": "claude-export",
    "chunk_mode": "turn"
  },
  "created_at": "2026-04-20T06:43:10.837655Z",
  "source_store": "claude-export",
  "vex_version": "1.0.0"
}
```

Text-only records (null vector) are valid vmig. They are BM25-searchable in VEKTOR and can be re-embedded at any time with `--reembed`.

---

# Cryptographic Integrity (v0.4.0)

```
memories.vmig.jsonl     — your exported memories
memories.vmig.meta.json — record count, SHA-256, timestamps
memories.vmig.sig       — BLAKE3 Merkle root + Ed25519 signature
memories.vmig.key       — your Ed25519 private key (keep safe)
```

Verification is fully self-contained — the `.vmig.sig` file contains the public key:

```bash
vex verify memories.vmig.jsonl
# ✓  Signature valid — file has not been tampered with
```

---

# Embedding Handling

| Scenario | Behaviour |
|----------|-----------|
| Same model, same dims | Vectors copied directly |
| Dim mismatch + `--reembed` | Re-embeds from `text` field via OpenAI or Ollama |
| Dim mismatch + `--adapter` | vec2vec projection — no API call (premium) |
| Dim mismatch, no flag | Records skipped with warning |
| `null` vector | Stored as text-only — BM25 searchable, not ANN searchable |

---

# Progress & Summary

```
[████████████████████] 100% vektor import (12491/12491)

┌─ vektor summary ───────────────────────
│  total records   : 12491
│  upserted        : 12491
│  skipped         : 0
│  duration        : 2.3s
└────────────────────────────────────────
```

---

# Roadmap

**v0.0.1 — shipped** · Initial scaffold, `.vmig.jsonl` spec, vektor export, jsonl round-trip

**v0.1.0 — shipped** · Pinecone + Qdrant import, checksums, batch retry, progress bar

**v0.2.0 — shipped** · Pinecone + Qdrant export, ChromaDB connector, namespace + limit flags

**v0.3.0 — shipped** · Weaviate + pgvector connectors, re-embedding pipeline, vec2vec adapter, streaming >100k, sqlite-vec ANN

**v0.4.0 — shipped** · BLAKE3 + Ed25519 signing, selective disclosure `--components`, LangChain adapter, dynamic schema detection

**v0.5.0 — shipped** · `claude-export` connector, `vex convert` command, 5 LLM format adapters

**v0.6.1 — shipped** · `chatgpt-export` connector, schema-adaptive vektor `load()`, accurate import counters

**v0.7 — next**
- Gemini export connector
- `--reembed` in conversation export connectors
- Streaming for large conversation exports (>50k records)

**v0.8**
- Perplexity + Grok export (CLOAK-assisted)
- Cross-provider conversation deduplication

---

# Contributing

PRs welcome — especially new connectors and convert adapters.

Each **connector** is a single file in `connectors/` implementing `{ extract(opts), load(records, opts), extractStream(opts, onPage) }`. Source-only connectors (like `claude-export`) implement `extract` + `extractStream` only.

Each **convert adapter** is an object in `adapters/convert/index.js` implementing `{ name, fileExtension, description, convert(records, opts) }`.

See `connectors/qdrant.js` as the reference connector. See `adapters/convert/index.js` for the adapter pattern.

---

# License

Apache 2.0 — free to use, fork, and build on.

[npm](https://www.npmjs.com/package/@vektormemory/vex) · [Docs](https://vektormemory.com) · Built by [VEKTOR](https://vektormemory.com) — persistent semantic memory for AI agents.
