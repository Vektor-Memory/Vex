# Vex — Vector Exchange - v0.3.3


<img width="1086" height="519" alt="image" src="https://github.com/user-attachments/assets/4d847c0c-eced-40d5-8013-f1480475931f" />
# Vex — Vector Exchange v0.4.0

> Cross-standard vector DB migration tool with cryptographic memory portability. Export, sign, verify, and migrate agent memory between vector stores using the open `.vmig.jsonl` interchange format.

https://medium.com/ai-in-plain-english/your-agent-memory-is-trapped-heres-the-key-87224b483534

<img width="1086" height="519" alt="image" src="https://github.com/user-attachments/assets/4d847c0c-eced-40d5-8013-f1480475931f" />

```bash
npx @vektormemory/vex export --from vektor --db slipstream-memory.db --output memories.vmig.jsonl
npx @vektormemory/vex sign memories.vmig.jsonl
npx @vektormemory/vex verify memories.vmig.jsonl
npx @vektormemory/vex import --from memories.vmig.jsonl --to pinecone --api-key $KEY --index my-index --host $HOST
npx @vektormemory/vex migrate --from vektor --to qdrant --db memory.db --url http://localhost:6333 --collection memories
```

## Why

Every vector DB has a different API, a different format, and zero interop. Moving your agent memory from VEKTOR to Pinecone, or Qdrant to Weaviate, means writing a one-off script every time.

`vex` fixes that with a single open format, a growing connector library, and — as of v0.4.0 — cryptographic signing so you can prove your agent memory hasn't been tampered with in transit.

Your memory is always exportable, always portable, always verifiable, always yours.

## What's New in v0.4.0

- **`vex sign`** — BLAKE3 content-addresses every record, Ed25519 signs the root hash. Writes a `.vmig.sig` sidecar.
- **`vex verify`** — Recomputes all hashes, verifies the signature. Exits 0 (valid) or 1 (tampered). Pipeline-safe.
- **`--sign` flag** — Auto-sign immediately after export in one command.
- **`--components` flag** — Selective disclosure. Export only `working`, `semantic`, `procedural`, `episodic`, or `identity` memories. Mirrors the [PAM five-component model](https://arxiv.org/abs/2605.11032).
- **LangChain adapter** — `VektorMemory` class, drop-in `BaseMemory` for any LangChain chain.
- **Dynamic schema detection** — vektor connector now handles all SDK versions automatically via `PRAGMA table_info`.

## Connectors

| Connector | Export | Import | Status |
|-----------|--------|--------|--------|
| `vektor`   | ✅ | ✅ | Stable — dynamic schema, sqlite-vec ANN optional |
| `jsonl`    | ✅ | ✅ | Stable |
| `pinecone` | ✅ | ✅ | Stable — tested 4,900 vectors |
| `qdrant`   | ✅ | ✅ | Stable — tested 3,917 vectors, auto-create |
| `chroma`   | ✅ | ✅ | Stable — auto-create collection |
| `weaviate` | ✅ | ✅ | Stable — GraphQL cursor pagination, extractStream |
| `pgvector` | ✅ | ✅ | Stable — schema introspection, extractStream |

<img width="1189" height="422" alt="image" src="https://github.com/user-attachments/assets/cf1473e1-d4a3-4283-8064-32bf79df6067" />

## Install

```bash
# Global install
npm install -g @vektormemory/vex

# Or run without installing
npx @vektormemory/vex --help

# Signing support (BLAKE3 + Ed25519)
npm install @noble/hashes @noble/ed25519

# Vex Adapter (vec2vec projection — optional, premium)
npm install @vektormemory/vex-adapter
```

**Requirements:** Node.js >= 18. No extra dependencies for Pinecone, Qdrant, Chroma, or Weaviate — connectors use the built-in fetch API. pgvector requires `npm install pg`.

## Commands

### Sign & Verify (v0.4.0)

```bash
# Sign an export — generates .vmig.sig + .vmig.key
vex sign memories.vmig.jsonl

# Sign with an existing key
vex sign memories.vmig.jsonl --key memories.vmig.key

# Verify integrity (exit 0 = valid, exit 1 = tampered)
vex verify memories.vmig.jsonl

# Pipeline: verify before import
vex verify memories.vmig.jsonl && vex import --from memories.vmig.jsonl --to qdrant --collection mem

# Export + auto-sign in one step
vex export --from vektor --db memory.db --output memories.vmig.jsonl --sign
```

The `.vmig.sig` sidecar contains:
- BLAKE3 hash of every individual record (canonical JSON)
- Root hash (BLAKE3 of the array of record hashes)
- Ed25519 signature of the root hash
- Public key (verifier needs no private key)

Tamper with any byte in any record and `vex verify` will catch it.

### Selective Disclosure (v0.4.0)

Export only specific memory component types — useful for multi-agent handoffs where different agents need different context.

```bash
# Export only working memory (current goals, TODOs, status)
vex export --from vektor --db memory.db --components "working" --output todos.vmig.jsonl

# Export working + procedural (skills + state) for a coding agent
vex export --from vektor --db memory.db --components "working,procedural" --output coding-ctx.vmig.jsonl

# Export semantic only (facts, knowledge)
vex export --from vektor --db memory.db --components "semantic" --output facts.vmig.jsonl
```

**Memory type taxonomy** (mirrors [PAM arXiv:2605.11032](https://arxiv.org/abs/2605.11032)):

| Type | Description | Use case |
|------|-------------|----------|
| `working` | Current goals, TODOs, active state | Planning agents |
| `semantic` | Facts, knowledge, assertions | Q&A agents |
| `procedural` | Skills, workflows, architecture | Coding agents |
| `episodic` | Time-ordered events, decisions | Temporal reasoning |
| `identity` | Preferences, persona, instructions | Personalisation |

Memory types are stored via [VEKTOR Slipstream](https://vektormemory.com) SDK v1.6.1+:
```js
await memory.remember('TODO: ship vex v0.4', { importance: 5, memory_type: 'working' });
await memory.remember('JWT tokens expire after 24 hours', { importance: 4, memory_type: 'semantic' });
```

### LangChain Adapter (v0.4.0)

Drop-in `BaseMemory` implementation backed by VEKTOR Slipstream:

```js
import { createVektorMemory } from '@vektormemory/vex/adapters/langchain';
import { ConversationChain } from 'langchain/chains';

// From a DB path
const vektorMem = await createVektorMemory({
  dbPath: './agent.db',
  topK: 5,
  importance: 3,
});

// Use in any LangChain chain
const chain = new ConversationChain({ llm, memory: vektorMem });
await chain.call({ input: 'What is our auth setup?' });

// Or use standalone
const ctx = await vektorMem.loadMemoryVariables({ input: 'JWT configuration' });
console.log(ctx.history); // top-5 relevant memories as formatted string

await vektorMem.saveContext(
  { input: 'What DB do we use?' },
  { output: 'PostgreSQL 15 with pgvector' }
);
```

**Options:**
```js
createVektorMemory({
  dbPath:         './agent.db',   // path to VEKTOR SQLite DB
  topK:           5,              // memories to inject per turn
  memoryKey:      'history',      // key written into chain variables
  minScore:       0.0,            // min similarity score to include
  includeScores:  false,          // show similarity scores in output
  importance:     3,              // importance for saved turns
  returnMessages: false,          // return as ChatMessage[] for chat models
})
```

### Export

```bash
# Export VEKTOR memory
vex export --from vektor --db ./slipstream-memory.db --output memories.vmig.jsonl

# Export + sign in one step
vex export --from vektor --db ./slipstream-memory.db --output memories.vmig.jsonl --sign

# Export specific components only
vex export --from vektor --db ./memory.db --components "working,procedural" --output ctx.vmig.jsonl

# Export specific namespace
vex export --from vektor --db ./memory.db --namespace trading --output trading.vmig.jsonl

# Export from Qdrant
vex export --from qdrant --url http://localhost:6333 --collection memories --output memories.vmig.jsonl

# Export from Pinecone
vex export --from pinecone --api-key $PINECONE_API_KEY --index my-index --host $HOST --output memories.vmig.jsonl

# Export from ChromaDB
vex export --from chroma --collection memories --output memories.vmig.jsonl

# Export from Weaviate
vex export --from weaviate --url http://localhost:8080 --collection MyDocs --output memories.vmig.jsonl

# Export from pgvector
vex export --from pgvector --url postgres://user:pass@host/db --table vex_vectors --output memories.vmig.jsonl
```

### Import

```bash
# → Pinecone
vex import --from memories.vmig.jsonl --to pinecone \
  --api-key $PINECONE_API_KEY \
  --index my-index \
  --host https://my-index-xxxx.svc.pinecone.io

# → Qdrant (auto-creates collection if missing)
vex import --from memories.vmig.jsonl --to qdrant \
  --url https://xxxx.cloud.qdrant.io:6333 \
  --collection my-collection \
  --api-key $QDRANT_API_KEY

# → Qdrant local (no auth)
vex import --from memories.vmig.jsonl --to qdrant --collection memories

# → ChromaDB
vex import --from memories.vmig.jsonl --to chroma --collection memories

# → Weaviate
vex import --from memories.vmig.jsonl --to weaviate --url http://localhost:8080 --collection MyDocs

# → pgvector (auto-creates table + ivfflat index)
vex import --from memories.vmig.jsonl --to pgvector --url postgres://user:pass@host/db

# → VEKTOR (re-import for cross-model transfer)
vex import --from memories.vmig.jsonl --to vektor --db ./target.db
```

### Migrate (direct — no intermediate file)

```bash
# VEKTOR → Qdrant
vex migrate --from vektor --to qdrant \
  --db ./memory.db --url http://localhost:6333 --collection memories

# VEKTOR → pgvector
vex migrate --from vektor --to pgvector \
  --db ./memory.db --url postgres://user:pass@host/db

# VEKTOR → Weaviate
vex migrate --from vektor --to weaviate \
  --db ./memory.db --url http://localhost:8080 --collection Memories
```

### Embedding flags

```bash
# Re-embed from text field when moving between models (requires OpenAI key or Ollama)
vex migrate --from vektor --to qdrant --db memory.db --collection memories \
  --reembed --embed-model text-embedding-3-small

# Ollama re-embed (local, no API key)
vex migrate --from vektor --to qdrant --db memory.db --collection memories \
  --reembed --embed-model nomic-embed-text --ollama-url http://localhost:11434

# vec2vec projection — translate embeddings without any API call (premium)
vex migrate --from memories.vmig.jsonl --to pinecone \
  --adapter --adapter-model text-embedding-3-small

# List available projection pairs
vex adapters
```

## .vmig.jsonl Format

One JSON object per line. UTF-8. Portable across any vector store.

```json
{
  "id": "1234",
  "text": "JWT tokens expire after 24 hours. Algorithm: RS256.",
  "vector": [0.021, -0.043, 0.018, "...384 or 768 floats"],
  "model": "bge-small-en-v1.5",
  "dims": 384,
  "namespace": "default",
  "metadata": {
    "tags": "auth,security",
    "importance": 4,
    "memory_type": "semantic",
    "agent_id": "default"
  },
  "created_at": "2026-05-29T10:23:00.000Z",
  "source_store": "vektor",
  "vex_version": "1.0.0"
}
```

**Key decisions:**
- Metadata is **flat** — Pinecone compatible out of the box
- `namespace` is top-level — structural routing, not descriptive metadata
- `text` field always preserved — enables cross-model re-embedding via `--reembed`
- `memory_type` in metadata — enables `--components` selective disclosure
- Sidecar `.vmig.meta.json` — record count, SHA-256 checksum, source store
- Sidecar `.vmig.sig` — BLAKE3 Merkle root + Ed25519 signature (v0.4.0+)

<img width="1187" height="552" alt="image" src="https://github.com/user-attachments/assets/5a5a8e92-6deb-4322-a5a8-9597f4a524ca" />

## Cryptographic Integrity (v0.4.0)

```
memories.vmig.jsonl     — your exported memories
memories.vmig.meta.json — record count, SHA-256, timestamps
memories.vmig.sig       — BLAKE3 Merkle root + Ed25519 signature
memories.vmig.key       — your Ed25519 private key (keep safe)
```

Verification is fully self-contained — the `.vmig.sig` file contains the public key, so anyone can verify without needing your private key:

```bash
vex verify memories.vmig.jsonl
# [vex verify] hashing 5725 records...
# ✓  Signature valid — file has not been tampered with
```

Verification checks three things:
1. Every record's BLAKE3 hash matches the hash stored in `.vmig.sig`
2. The root hash (BLAKE3 of all record hashes) matches
3. The Ed25519 signature of the root hash is valid

## Embedding Handling

| Scenario | Behaviour |
|----------|-----------|
| Same model, same dims | Vectors copied directly — no re-embedding |
| Dim mismatch + `--reembed` | Re-embeds from `text` field via OpenAI or Ollama |
| Dim mismatch + `--adapter` | vec2vec projection — no API call (premium) |
| Dim mismatch, no flag | Records skipped with warning + count in summary |
| `null` vector | Record skipped with warning |

## Progress & Summary

```
[████████████████████] 100% pinecone (4900/4900)

┌─ pinecone summary ─────────────────────────
│  total records   : 4900
│  upserted        : 4900
│  skipped         : 0
│  duration        : 87.3s
└────────────────────────────────────────────
```

## sqlite-vec (Optional — ANN Search)

The `vektor` connector supports [sqlite-vec](https://github.com/asg017/sqlite-vec) for native approximate nearest neighbour search inside SQLite. Without it, vex works fine — export falls back to standard `ORDER BY created_at`.

```bash
npm install sqlite-vec

# Backfill existing database
node scripts/migrate-vec.mjs --db slipstream-memory.db

# ANN-ordered export
vex export --from vektor --db memory.db \
  --vec-query '[0.021, -0.043, 0.018, ...]' \
  --limit 50 \
  --output results.vmig.jsonl
```

## Roadmap

**v0.0.1 — shipped** — VEKTOR export, JSONL round-trip, format spec v1.0.0

**v0.1.0 — shipped** — Pinecone + Qdrant import, SHA-256 checksum, batch retry, progress bar

**v0.2.0 — shipped** — Pinecone + Qdrant export, ChromaDB connector, `--namespace` + `--limit` flags

**v0.3.0 — shipped** — Weaviate + pgvector connectors, `--reembed`, vec2vec adapter, streaming for >100k vectors, sqlite-vec ANN

**v0.4.0 — shipped**
- `vex sign` / `vex verify` — BLAKE3 + Ed25519 cryptographic signing
- `--components` — selective disclosure by memory type
- `--sign` — auto-sign on export
- LangChain adapter — `VektorMemory` `BaseMemory` implementation
- Dynamic schema detection — handles all VEKTOR SDK DB versions

**v0.5.0 — planned**
- `vex diff` — compare two `.vmig.jsonl` snapshots, surface added/removed/modified memories
- Capability tokens — scoped read/export permissions per component type
- TypeScript type definitions
- Mem0 + Letta import connectors

## Contributing

PRs welcome — especially new connectors.

Each connector is a single file in `connectors/` implementing:

```js
{ extract(opts), load(records, opts), extractStream(opts, onPage) }
```

See `connectors/qdrant.js` as the reference implementation. The Vex core handles batching, dimension filtering, retry, progress, and sidecar generation.

## License

Apache 2.0 — free to use, fork, and build on.

---

[npm](https://www.npmjs.com/package/@vektormemory/vex) · [Docs](https://vektormemory.com/vex)
Built by [VEKTOR](https://vektormemory.com) — persistent semantic memory for AI agents.
