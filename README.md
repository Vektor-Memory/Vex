# Vex — Vector Exchange - v0.3.3

> Cross-standard vector DB migration tool. Export, import, and migrate agent memory between vector stores using the open `.vmig.jsonl` interchange format.


<img width="1086" height="519" alt="image" src="https://github.com/user-attachments/assets/4d847c0c-eced-40d5-8013-f1480475931f" />

```bash
npx @vektormemory/vex export --from vektor --db slipstream-memory.db --output memories.vmig.jsonl
npx @vektormemory/vex import --from memories.vmig.jsonl --to pinecone --api-key $KEY --index my-index --host $HOST
npx @vektormemory/vex import --from memories.vmig.jsonl --to qdrant --collection memories
npx @vektormemory/vex migrate --from vektor --to qdrant --db memory.db --url http://localhost:6333 --collection memories
```

## Why

Every vector DB has a different API, a different format, and zero interop. Moving your agent memory from VEKTOR to Pinecone, or Qdrant to Weaviate, means writing a one-off script every time.

`vex` fixes that with a single open format and a growing connector library. Your memory is always exportable, always portable, always yours.

## Connectors

| Connector | Export | Import | Status |
|-----------|--------|--------|--------|
| `vektor`   | ✅ | ✅ | Stable |
| `jsonl`    | ✅ | ✅ | Stable |
| `pinecone` | ✅ | ✅ | Stable — tested 4,900 vectors |
| `qdrant`   | ✅ | ✅ | Stable — tested 3,917 vectors, auto-create |
| `chroma`   | ✅ | ✅ | Stable — auto-create collection |
| `weaviate` | ✅ | ✅ | Stable — GraphQL cursor pagination, extractStream |
| `pgvector` | ✅ | ✅ | Stable — schema introspection, extractStream |
| `vektor`   | ✅ | ✅ | Stable — sqlite-vec ANN optional |



<img width="1189" height="422" alt="image" src="https://github.com/user-attachments/assets/cf1473e1-d4a3-4283-8064-32bf79df6067" />

## Install

```bash
# Global install
npm install -g @vektormemory/vex

# Or run without installing
npx @vektormemory/vex --help

# Vex Adapter (vec2vec projection — optional, premium)
npm i @vektormemory/vex-adapter
```

**Requirements:** Node.js >= 18 (native fetch required). No extra dependencies for Pinecone, Qdrant, Chroma, or Weaviate — connectors use the built-in fetch API. pgvector requires `npm install pg`.
VEKTOR sqlite-vec ANN (optional): `npm install sqlite-vec` — enables native ANN search, falls back gracefully if absent.

## Commands

### Export

```bash
# Export VEKTOR memory to portable .vmig.jsonl file
vex export --from vektor --db ./slipstream-memory.db --output memories.vmig.jsonl

# Export a specific namespace only
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

### Embedding flags (v0.3+)

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
  "text": "Pepe trending #5 on CoinGecko (+2.0% 24h)",
  "vector": [0.021, -0.043, 0.018, "...384 or 768 floats"],
  "model": "bge-small-en-v1.5",
  "dims": 384,
  "namespace": "trading",
  "score": null,
  "metadata": {
    "tags": "crypto,trending",
    "importance": 1.0,
    "agent_id": "default"
  },
  "created_at": "2025-01-15T10:23:00.000Z",
  "source_store": "vektor",
  "vex_version": "1.0.0"
}
```

<img width="1187" height="552" alt="image" src="https://github.com/user-attachments/assets/5a5a8e92-6deb-4322-a5a8-9597f4a524ca" />

**Key decisions:**
- Metadata is **flat** — Pinecone compatible out of the box
- `namespace` is top-level — structural routing, not descriptive metadata
- `text` field always preserved — enables cross-model re-embedding via `--reembed`
- `score` field included — useful for search-result exports
- Sidecar `.vmig.meta.json` for file-level metadata (record count, SHA-256 checksum, source store)

## Embedding Handling

| Scenario | Behaviour |
|----------|-----------|
| Same model, same dims | Vectors copied directly — no re-embedding |
| Dim mismatch + `--reembed` | Re-embeds from `text` field via OpenAI or Ollama |
| Dim mismatch + `--adapter` | vec2vec projection — no API call (premium) |
| Dim mismatch, no flag | Records skipped with warning + count in summary |
| `null` vector | Record skipped with warning |

## Sidecar Metadata

```json
{
  "exported_at": "2025-01-15T10:23:00.000Z",
  "source_store": "vektor",
  "record_count": 5026,
  "checksum": "sha256:abc123...",
  "vex_version": "1.0.0"
}
```

After import, the sidecar is updated with `imported_to` and `imported_at` fields for full auditability.

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

The `vektor` connector supports [sqlite-vec](https://github.com/asg017/sqlite-vec) for native approximate nearest neighbour search inside SQLite. Without it, vex works fine — search falls back to standard `ORDER BY created_at` export.

**Install the peer dep:**
```bash
npm install sqlite-vec
```

**Backfill existing database:**
```bash
node scripts/migrate-vec.mjs --db slipstream-memory.db
node scripts/migrate-vec.mjs --db slipstream-memory.db --dims 768  # if not 384
node scripts/migrate-vec.mjs --db slipstream-memory.db --dry-run   # check only
```

**ANN-ordered export:**
```bash
vex export --from vektor --db memory.db \
  --vec-query '[0.021, -0.043, 0.018, ...]' \
  --limit 50 \
  --output results.vmig.jsonl
```

Returns the top-k most semantically similar records ordered by cosine distance — no full table scan, no JS loop.

## Roadmap

**v0.0.1 — shipped**
- VEKTOR export
- JSONL round-trip
- Format spec v1.0.0

**v0.1.0 — shipped**
- Pinecone import (tested: 4,900 vectors)
- Qdrant import (tested: 3,917 vectors, auto-create collection)
- SHA-256 checksum in sidecar meta
- Batch retry with backoff (3x)
- Progress bar + summary block

**v0.2.0 — shipped**
- Pinecone export — paginated ID listing + batched vector fetch
- Qdrant export — scroll API with cursor pagination
- ChromaDB connector — full import + export, auto-create collection
- `--namespace` filter on all export connectors
- `--limit` flag for partial exports

**v0.3.0 — shipped**
- Weaviate connector — GraphQL cursor pagination, auto-create class, extractStream
- pgvector connector — schema introspection, cursor-paginated export, ivfflat index auto-create, extractStream
- Re-embedding pipeline — `--reembed` from `text` field via OpenAI or Ollama
- vec2vec adapter — `--adapter` projects embeddings between models without any API call
- Streaming for >100k vectors — line-by-line export/import, never loads full dataset into memory
- sqlite-vec ANN index support for VEKTOR connector — native cosine search inside SQLite
- `scripts/migrate-vec.mjs` — one-shot backfill tool for existing databases
- `--vec-query` flag — ANN-ordered export without full table scan

**v0.4 (premium)**
- Pre-trained vex-adapter weights (vec2vec translation — no re-embedding required)
- Multimodal support

## Contributing

PRs welcome — especially new connectors.

Each connector is a single file in `connectors/` implementing two functions:

```js
{ extract(opts), load(records, opts) }
// optional: extractStream(opts, onPage) for true zero-memory export
```

See `connectors/qdrant.js` as the reference implementation. The Vex core handles batching, dimension filtering, retry, progress, and sidecar generation.

## License

Apache 2.0 — free to use, fork, and build on.

---

Built by [VEKTOR](https://vektormemory.com) — persistent semantic memory for AI agents.
