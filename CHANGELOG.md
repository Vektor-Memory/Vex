# VEX Changelog

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
