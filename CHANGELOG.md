## [0.6.1] - 2026-06-05

### Fixed
- vektor connector: FTS5 triggers with TEXT id as rowid caused datatype mismatch on import into Slipstream DBs with v1.5+ schema. Triggers suspended before bulk import and rebuilt after.
- vektor connector: created_at normalised to unix timestamp when target schema uses NUM column.

## [0.6.0] - 2026-06-04

### Added
- **`chatgpt-export` connector** — import ChatGPT conversation history from the official data export (`conversations.json`). Handles the tree-structured `mapping` format by walking from `current_node` to root and reconstructing the active linear thread. Supports all three chunking modes and sender filter, same interface as `claude-export`.
- **Schema-adaptive `vektor` connector** — `load()` now detects the target DB's column names, primary key type, and available columns at runtime before building the INSERT statement. Works with any VEKTOR DB schema without modification: minimal (6 columns), full SDK (26 columns), integer ID, TEXT ID.
- **Accurate import counters** — `streamImport()` and `migrate()` in `core/migrate.js` now use the connector's own `{ upserted, skipped }` return value as the source of truth. Previous behaviour counted upserted as records-with-vectors which returned 0 for text-only imports. `vektor.js` `load()` now returns `{ upserted, skipped }`.
- **`chatgpt-export` wired into CLI** — appears in `vex --help` CONNECTORS box, CONVERSATION EXPORT FLAGS section, and EXAMPLES section.

### Fixed
- `vektor.js` `load()` — FTS5 trigger compatibility: INSERT now uses `@vec` named parameter mapped to the detected vector column (`embedding` or `vector`), eliminating `datatype mismatch` errors on DBs where the column name differs from the hardcoded assumption.
- `core/migrate.js` `streamImport()` — removed vector-presence heuristic for counting upserted/skipped. Connector return value is now authoritative. Falls back to `resolved.length` for connectors that don't return counts (Pinecone, Qdrant, etc.) — assumes all succeeded, consistent with previous behaviour.
- `adapters/convert/index.js` — `generic-chat` adapter no longer silently drops single-turn conversations. Threshold changed from `< 2` to `< 1` non-system messages.
- `vex.mjs` `cmdConvert()` — `--adapter list` no longer requires `--from` to be specified.

### Changed
- Version bumped to `0.6.0`
- `connectors/index.js` — `chatgpt-export` registered alongside `claude-export`

---

## [0.5.0] - 2026-06-04

### Added
- **`claude-export` connector** — import Claude conversation history from the official claude.ai data export (`conversations.json`). Handles both claude.ai export shape (`chat_messages` array) and OpenAI API shape (`messages` array). Three chunking modes: `turn` (default), `conversation`, `exchange`. Sender filter (`both`, `user`, `assistant`). Date range filters (`--after`, `--before`). Conversation name filter. Optional embedding via `--embed-url`, `--openai-key`, or `--ollama-url`. Text-only records (null vector) are valid vmig and BM25-searchable in VEKTOR.
- **`vex convert` command** — transform `.vmig.jsonl` conversation records into provider-specific formats. `--adapter list` shows all available adapters.
- **`adapters/convert/index.js`** — five format adapters:
  - `openai-finetune` — `{messages:[{role,content}]}` JSONL for `/v1/fine_tuning/jobs`. Validates user+assistant presence per conversation.
  - `openai-context` — messages array JSON for direct chat completion injection. Supports `--max-tokens` budget hint and `--conversation-id` filter.
  - `generic-chat` — OpenAI-compatible `{role,content}` JSONL. Works with Perplexity, Groq, Mistral, Together, Fireworks, Cerebras. Includes `_meta` block with conversation ID and name.
  - `anthropic-finetune` — Anthropic Messages API format with strict user/assistant alternation (consecutive same-role messages merged). Optional `system` field.
  - `plain-text` — human-readable transcript with configurable separator, role labels `[HUMAN]` / `[ASSISTANT]`.
  - Aliases: `perplexity`, `groq`, `mistral`, `together` → `generic-chat`; `anthropic` → `anthropic-finetune`; `txt` → `plain-text`.
- `vex.mjs` — new CONNECTORS help entry for `claude-export`, new CONVERT ADAPTERS help box, new CONVERSATION EXPORT FLAGS box, new CONVERT FLAGS box, `cmdConvert()` function, `convert` in interactive menu.

### Changed
- Version bumped to `0.5.0`

---

## [0.4.0] - 2026-05-05

### Added
- **BLAKE3 + Ed25519 signing** — `vex sign <file>` signs a `.vmig.jsonl` export; `vex verify <file>` exits 0 if valid, 1 if tampered. Key auto-generated on first sign, saved alongside export. Requires `@noble/hashes` + `@noble/ed25519` (optional peer deps).
- **`--sign` flag on export** — auto-signs after export in one step.
- **PAM five-component selective disclosure** — `--components working,procedural` filters export by `memory_type` field. Valid types: `episodic`, `semantic`, `procedural`, `working`, `identity`.
- **vec2vec adapter integration** — `--adapter` + `--adapter-model` invoke `@vektormemory/vex-adapter` for embedding projection without any re-embedding API call. `vex adapters` lists available projection pairs.
- `core/sign.js` — BLAKE3 hash of all record lines + Ed25519 signature over hash. Sidecar `.vmig.sig` file.
- `utils/adapt.js` — lazy loader for `@vektormemory/vex-adapter` with graceful error if not installed.

### Changed
- Version bumped to `0.4.0`

---

## [0.3.0] - 2026-05-02

### Added
- **Weaviate connector** — full export + import, GraphQL cursor pagination, auto-create class, batch upsert, `extractStream()` for large datasets
- **pgvector connector** — full export + import, schema introspection, cursor-paginated export, ivfflat index auto-create, `extractStream()` for zero-memory large-table export
- **Re-embedding pipeline** — `--reembed` flag re-embeds from text field via OpenAI or Ollama; `--embed-model` to override
- **vec2vec adapter** — `--adapter` invokes `@vektormemory/vex-adapter` for projection without API call; `vex adapters` lists available pairs
- **Streaming for >100k vectors** — `streamExport()` via WriteStream, `streamImport()` in 500-record batches; `migrate()` auto-switches at 100k threshold
- **`dimCheck()` in core** — resolves dim mismatches: `--adapter` > `--reembed` > skip, per-batch during streaming import
- **sqlite-vec ANN support** — `vektor` connector loads sqlite-vec extension if installed; `--vec-query` flag for ANN-ordered export
- **`scripts/migrate-vec.mjs`** — one-shot backfill tool to populate `memories_vec` from existing embeddings

### Fixed
- `qdrant.js` — spaced optional chain and nullish coalescing causing SyntaxError on Node 24
- `pgvector.js` — `extractStream()` was outside connector object literal

---

## [0.2.0] - 2026-05-02

### Added
- Qdrant export — scroll API with cursor pagination
- Pinecone export — list IDs + batch fetch, paginated
- VEKTOR import — `load()` writes records into SQLite as Float32Array blobs, batched transactions
- ChromaDB connector — full `extract()` + `load()`, auto-create collection
- `--namespace` flag — filter export by namespace
- `--limit` flag — cap export at N records
- CLI redesigned — multi-depth blue palette

---

## [0.1.0] - 2026-05-02

### Added
- `vex import` command
- Pinecone import (tested — 4,900 vectors)
- Qdrant import (tested — 3,917 vectors, auto-create)
- SHA-256 checksum in sidecar meta
- Batch retry with backoff (3x)
- Progress bar + summary block

---

## [0.0.1] - 2026-05-01

### Added
- Initial scaffold
- `.vmig.jsonl` format spec v1.0.0
- Connectors: `jsonl`, `vektor` (export only)
- CLI: `vex export --from vektor --output file.vmig.jsonl`
