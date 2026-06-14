# VEX Changelog

## v0.8.6 (2026-06-15)

### Added: Interactive TUI — full arrow-key command palette

Running `vex` with no arguments now launches an Ink-powered terminal UI instead
of showing plain-text help. Each command has a guided wizard that builds the
correct flags from step-by-step prompts.

```bash
vex           # launches interactive TUI (real TTY only)
vex --help    # plain-text help unchanged
vex export --from vektor --output mem.vmig.jsonl   # direct CLI unchanged
```

**Palette** — arrow keys to navigate, enter to select, `q` to quit.

**Per-command wizards:**

| Command | Wizard flow |
|---|---|
| `export` | store picker → DB path (vektor only) → output path |
| `import` | file path → store picker |
| `migrate` | from-store picker → to-store picker |
| `convert` | file path → adapter picker (5 formats) |
| `sync` | action picker (init / push / pull / status / diff) |
| `sign` | file path input + key generation hint |
| `verify` | file path input |
| `inspect` | file path input |
| `validate` | file path input |
| `adapters` | immediate run — no input needed |

All 11 connectors available in pickers: vektor, claude-export, chatgpt-export,
pinecone, qdrant, chroma, weaviate, pgvector, redis, milvus, neo4j.

**TTY guard** — TUI only launches when `process.stdout.isTTY && !process.env.CI`.
Falls back to plain help in CI, pipes, and Docker. All existing CLI flags and
subcommands work identically — zero breaking changes.

### Fixed

- **`cmdConvert` calling convention** — was calling `adapter.convert(flags)`
  passing the flags object where the records array should go. Adapter signature
  is `convert(records, opts)`. Fixed to `readJsonl(flags.from)` then
  `adapter.convert(records, flags)`. Resolved `Cannot read properties of
  undefined (reading 'separator')` on every convert invocation.
- **`listConvertAdapters()` awaited unnecessarily** — function is synchronous
  but was being called with `await`. Removed.
- **`vex convert --from` missing guard** — calling convert without `--from` gave
  a confusing crash. Now exits cleanly with usage message.
- **`spawnSync` shell deprecation on Node 24** — TUI's internal `spawnSync` call
  removed `shell: true` to suppress `[DEP0190]` deprecation warning.
- **VERSION constant** — was hardcoded as `'0.8.5'` while `package.json` read
  `0.8.6`. Corrected to match.

### Testing

Added `test_vex.py` — 53 tests across 10 sections:
- Entry point, inspect, validate, adapters, convert (all 5 adapters)
- Sign + verify including tamper detection
- Export, import, migrate error handling
- Sync subcommands
- Module resolution for all 6 core modules

Fixture writes use `encoding='utf-8', newline='\n'` (no BOM) and include
`vex_version: "1.0.0"` so validate passes correctly on Windows.

### Dependencies added
```json
"ink": "^5.0.0",
"react": "^18.0.0",
"ink-select-input": "^5.0.0",
"ink-text-input": "^6.0.0"
```

Install before first use: `npm install ink react ink-select-input ink-text-input`

---

## v0.8.5 (2026-06-12)

### New Feature: `vex sync` — Sovereign Hybrid Memory Backup

Back up VEKTOR memory to any Git host with client-side AES-256-GCM encryption. Cloud stores ciphertext only. Key is derived from machine-id + token — never leaves your machine. No VEKTOR servers involved at any point.

**Providers supported:**
- **GitHub** — free private repos, familiar tooling
- **Codeberg** — free, nonprofit, GDPR-compliant, no tracking (recommended)
- **Gitea** — self-hosted, full sovereignty, single binary, runs on any VPS
- **GitLab** — gitlab.com or self-hosted

**Commands:**
```bash
vex sync init   --provider codeberg --token cb_xxx --owner alice --repo vektor-backup --db ~/.vektor/memory.db
vex sync push   [--min-importance 3]  [--namespace default]  [--limit 500]
vex sync pull   --db ~/new-machine.db  [--dry-run]
vex sync status
vex sync diff
```

**Architecture:**
- Export memories from local DB
- Encrypt with AES-256-GCM (HKDF key: machine-id + tokenHash — derived locally, never transmitted)
- Push encrypted blob to `memory/vektor-backup.enc` in private Git repo
- Push plaintext manifest (count + timestamp only, no memory content) to `memory/manifest.json`
- Pull: fetch blob, decrypt, upsert into target DB
- Config stored at `~/.vex/sync.json`, token at `~/.vex/sync.key` (chmod 600)

**Restore on a new machine:** re-run `vex sync init` with your original token, then `vex sync pull`.

---

## v0.8.4 (2026-06-07)

- Version bump and stability fixes

---

## v0.8.2 (2026-06-06)

### Bug Fixes

**parseFlags off-by-one (critical)**
The CLI argument parser started its loop at index 1, silently dropping the first flag on every invocation. This caused `--from`, `--groq-key`, and other leading flags to be ignored, making all provider key authentication fail silently. Fixed: loop now starts at index 0.

**buildPrompt text truncation**
`buildPrompt()` in `02-extract.js` sliced conversation text to 2000 characters before sending to the LLM. A 3.5MB conversation was being truncated to near-empty context, yielding 0 facts. Fixed: raised to 8000 characters.

**Token budget regression**
All three LLM call branches (Ollama spec-decoding, standard Ollama, Groq/OpenAI-compatible) had `num_predict`/`max_tokens` set to 600. Adding `tags` and `potential` fields to the schema roughly doubled per-fact response size (~70 to ~130 tokens), causing truncated JSON, parse failures, and timeout cascades under concurrency. Fixed: all three branches raised to 1400 tokens.

**graph-builder.js datatype mismatch**
`INSERT INTO graph_edges` used `strftime('%s','now')` for a `created_at INTEGER` column. SQLite returns text from strftime in some versions, causing a datatype mismatch crash on graph write. Fixed: wrapped with `CAST(strftime('%s','now') AS INTEGER)`.

**05-embed.js silent failures**
Embed batch errors were swallowed silently. Auth failures (401, invalid key) caused all vectors to be skipped with no indication why. Fixed: explicit error logging with provider key status displayed at startup.

### New Features

**tags field on extracted facts**
Each extracted fact now includes `tags: []` with 1 to 4 lowercase keywords (e.g. `config`, `bug`, `decision`). Tags pass through the full pipeline and are stored in the DB, enabling tag-based graph edges and filtered recall.

**potential field on extracted facts**
Each fact now includes `potential: []` with exactly 3 natural-language questions the fact answers. Pre-generating likely query patterns at extraction time improves BM25 recall quality significantly.

**Redis connector**
Full Redis / Redis Stack support with RediSearch VSS vector index (HNSW, COSINE), plain hash fallback when RediSearch is unavailable, and pipeline-batched writes. Install: `npm install redis`.

**Milvus / Zilliz connector**
Milvus and Zilliz Cloud support with IVF_FLAT vector index, automatic collection creation, dimension detection, and zero-vector fallback for records without embeddings. Install: `npm install @zilliz/milvus2-sdk-node`.

**Neo4j connector**
Neo4j and Aura Cloud support with MERGE-based upserts, automatic constraint and index creation, Entity node extraction, and temporal plus tag-similarity edge building via Cypher. Install: `npm install neo4j-driver`.

**pgvector connector**
PostgreSQL + pgvector support with HNSW index (falls back to IVFFlat for older versions), ON CONFLICT upsert, Supabase compatible, and full metadata storage including tags, entities, and potential fields. Install: `npm install pg`.

### Migration Results (2026-06-06)
- 156 Claude conversations, 289 chunks
- 1637 facts extracted, scored, and deduped
- 1628 facts with 1536-dim vectors (text-embedding-3-small)
- 10944 graph edges built
- Runtime: ~12 minutes, concurrency 5, OpenAI provider

---

## v0.8.1 (2026-06-05)

- Extraction pipeline with LLM fact extraction (Groq, Ollama, OpenAI, Anthropic, Mistral, Together)
- Provider cascade with automatic fallback
- Key rotation round-robin for Groq free tier
- Smart chunking mode for mixed conversation sizes
- vmig format with BLAKE3 + Ed25519 signing and verification
- vec2vec projection adapters (no re-embedding required)
- LangChain integration via `./adapters/langchain`
- Convert adapters: OpenAI fine-tuning, Anthropic Messages, generic chat, plain text

---

## v0.3.2 (2026-05-01)

- Initial public release
- export, import, migrate, convert, sign, verify, inspect, validate commands
- Connectors: vektor, jsonl, pinecone, qdrant, chroma, weaviate, pgvector, claude-export, chatgpt-export
