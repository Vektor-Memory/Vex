# VEX — Vector Exchange - v0.8.6

**Cross-standard vector DB migration, memory portability, and sovereign backup for AI agents.**
<img width="1026" height="445" alt="image" src="https://github.com/user-attachments/assets/228b7efe-f2e5-4d22-822e-02e584d522cd" />



Move memories between any vector store. Import Claude and ChatGPT conversation history with LLM fact extraction. Back up encrypted memory to GitHub, Codeberg, or self-hosted Gitea. Convert to any LLM provider format.

```bash
npm install -g @vektormemory/vex
```

[![npm](https://img.shields.io/npm/v/@vektormemory/vex)](https://www.npmjs.com/package/@vektormemory/vex)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green)](package.json)

---

## Commands

| Command | Description |
|---------|-------------|
| `vex sync` | **Sovereign hybrid backup** — encrypt and push memory to GitHub, Codeberg, or Gitea |
| `vex migrate` | Migrate directly between any two vector stores |
| `vex export` | Export memory to `.vmig.jsonl` portable format |
| `vex import` | Import `.vmig.jsonl` into any store |
| `vex convert` | Convert to OpenAI, Anthropic, Groq, or plain text format |
| `vex sign` | Sign export with BLAKE3 + Ed25519 |
| `vex verify` | Verify export signature |
| `vex inspect` | Show stats, namespaces, dimensions |
| `vex validate` | Lint all records in a `.vmig.jsonl` file |

---

## Connectors

| Store | Import | Export | Notes |
|-------|--------|--------|-------|
| **VEKTOR Slipstream** | ✓ | ✓ | Local SQLite, full MAGMA graph |
| **Pinecone** | ✓ | ✓ | Serverless and pod-based |
| **Qdrant** | ✓ | ✓ | Local and Cloud |
| **ChromaDB** | ✓ | ✓ | Local and hosted |
| **Weaviate** | ✓ | ✓ | Local and Cloud |
| **pgvector** | ✓ | ✓ | PostgreSQL, Supabase compatible |
| **Redis** | ✓ | ✓ | RediSearch VSS, plain hash fallback |
| **Milvus / Zilliz** | ✓ | ✓ | Local Milvus and Zilliz Cloud |
| **Neo4j** | ✓ | ✓ | Local and Aura Cloud |
| **Claude export** | ✓ | — | conversations.json from Claude |
| **ChatGPT export** | ✓ | — | conversations.json from ChatGPT |
| **.vmig.jsonl** | ✓ | ✓ | Portable interchange format |

---

## Sovereign Backup — `vex sync`

Back up VEKTOR memory to any Git host. Encrypted client-side with AES-256-GCM. Cloud stores ciphertext only — no plaintext memory ever leaves your machine.

**Supported providers:**

| Provider | Cost | Notes |
|----------|------|-------|
| **GitHub** | Free private repos | Familiar, reliable |
| **Codeberg** | Free, nonprofit | GDPR-compliant, no tracking — recommended |
| **Gitea** | Self-hosted | Full sovereignty, single binary, runs on any VPS |
| **GitLab** | Free tier | gitlab.com or self-hosted |

```bash
# Initialize with Codeberg (recommended — free, GDPR, nonprofit)
vex sync init --provider codeberg \
  --token cb_xxx \
  --owner alice \
  --repo vektor-backup \
  --db ~/.vektor/slipstream-memory.db

# Initialize with GitHub
vex sync init --provider github \
  --token ghp_xxx \
  --owner alice \
  --repo vektor-backup \
  --db ~/.vektor/slipstream-memory.db

# Initialize with self-hosted Gitea (full sovereignty)
vex sync init --provider gitea \
  --gitea-url https://git.example.com \
  --token xxx \
  --owner alice \
  --repo vektor-backup \
  --db ~/.vektor/slipstream-memory.db

# Push all memories (encrypted)
vex sync push

# Push only high-importance memories (lean backup)
vex sync push --min-importance 3

# Check sync status
vex sync status

# Compare local vs remote
vex sync diff

# Restore to new machine
vex sync pull --db ~/new-machine-memory.db

# Dry run restore (preview without writing)
vex sync pull --db ~/memory.db --dry-run
```

**How encryption works:**
- Key = HKDF-SHA256(machine-id + token hash) — derived locally, never transmitted
- Payload = AES-256-GCM encrypted export — blob is opaque to the Git host
- Manifest = plaintext metadata only (memory count, timestamp) — no content
- To restore on a new machine: provide your original token + re-run `vex sync init`

---

## Quick Start

### Import Claude conversation history with fact extraction

```bash
# Smart mode: extracts facts using LLM, scores by importance, deduplicates
vex migrate --from claude-export --to vektor \
  --file conversations.json \
  --db memory.db \
  --mode smart \
  --groq-key $GROQ_KEY \
  --namespace my-history

# With OpenAI (recommended for large exports)
vex migrate --from claude-export --to vektor \
  --file conversations.json \
  --db memory.db \
  --mode smart \
  --openai-key $OPENAI_KEY \
  --extract-model openai:gpt-4o-mini \
  --concurrency 5
```

### Migrate between vector stores

```bash
# VEKTOR → Pinecone
vex migrate --from vektor --to pinecone \
  --db memory.db \
  --api-key $PINECONE_KEY \
  --index my-index \
  --host $PINECONE_HOST

# VEKTOR → Redis (with RediSearch VSS)
vex migrate --from vektor --to redis \
  --db memory.db \
  --redis-url redis://localhost:6379 \
  --index vex-memory

# VEKTOR → Neo4j (builds full knowledge graph)
vex migrate --from vektor --to neo4j \
  --db memory.db \
  --neo4j-url bolt://localhost:7687 \
  --neo4j-user neo4j \
  --neo4j-password secret

# VEKTOR → Milvus
vex migrate --from vektor --to milvus \
  --db memory.db \
  --milvus-url localhost:19530 \
  --collection vex_memory

# VEKTOR → PostgreSQL + pgvector
vex migrate --from vektor --to pgvector \
  --db memory.db \
  --url postgres://user:pass@localhost:5432/mydb
```

### Export and convert

```bash
# Export to portable vmig format
vex export --from vektor --db memory.db --output memories.vmig.jsonl

# Convert for OpenAI fine-tuning
vex convert --from memories.vmig.jsonl --adapter openai-finetune --output finetune.jsonl

# Convert for Anthropic Messages API
vex convert --from memories.vmig.jsonl --adapter anthropic-finetune --output anthropic.jsonl

# Convert for Groq / Mistral / Together / Perplexity
vex convert --from memories.vmig.jsonl --adapter generic-chat --output chat.jsonl

# Plain text transcript
vex convert --from memories.vmig.jsonl --adapter plain-text --output transcript.txt
```

### Sign and verify exports

```bash
# Sign for tamper-evident transfer (BLAKE3 + Ed25519)
vex sign memories.vmig.jsonl

# Verify before importing
vex verify memories.vmig.jsonl && vex import --from memories.vmig.jsonl --to qdrant --collection mem
```

---

## Extraction Pipeline

When using `--mode extract` or `--mode smart`, VEX runs a 7-step pipeline:

1. **Chunk** — split conversations by mode (turn, conversation, exchange)
2. **Extract** — LLM fact extraction with importance scoring, tags, and potential questions
3. **Score** — filter by importance threshold (default 0.5)
4. **Dedup** — remove near-duplicates (default threshold 0.72)
5. **Embed** — generate vectors via OpenAI, Ollama, or custom endpoint
6. **Graph** — build temporal, tag, and causal edges between facts
7. **Store** — write to target vector store

### Provider cascade

```bash
# Auto-detect from config
vex migrate ... --provider auto

# Explicit cascade: Groq first, fall to Ollama
vex migrate ... --provider groq,ollama --groq-key $KEY --ollama-url http://localhost:11434

# Key rotation: 3 Groq keys triples effective TPM budget
vex migrate ... --provider groq --groq-key $KEY1,$KEY2,$KEY3

# Override model per provider
vex migrate ... --extract-model groq:llama-3.3-70b-versatile,ollama:mistral
```

---

## Extraction Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--mode` | `raw` | `raw`, `extract`, or `smart` |
| `--provider` | `auto` | `groq`, `ollama`, `openai`, `anthropic`, `mistral`, `together` |
| `--groq-key` | — | Groq API key(s), comma-separated for rotation |
| `--openai-key` | — | OpenAI API key |
| `--anthropic-key` | — | Anthropic API key |
| `--ollama-url` | localhost:11434 | Ollama endpoint |
| `--extract-model` | provider default | Override model, e.g. `groq:llama-3.3-70b-versatile` |
| `--min-importance` | `0.5` | Filter threshold |
| `--concurrency` | `3` | Parallel LLM calls (use 1 for free Groq tier) |
| `--dry-run` | — | Preview facts without storing |
| `--namespace` | — | Tag all stored records with namespace |

---

## The vmig Format

`.vmig.jsonl` is VEX's portable interchange format. Each line is a JSON record:

```json
{
  "id": "uuid",
  "text": "The fact or memory content",
  "vector": [0.1, 0.2, ...],
  "namespace": "my-history",
  "source": "vektor",
  "created_at": 1780525199,
  "metadata": {
    "importance": 0.85,
    "tags": ["decision", "architecture"],
    "potential": [
      "What database did Mini choose?",
      "Why was SQLite selected over Postgres?",
      "What storage approach does VEKTOR use?"
    ]
  }
}
```

Files can be inspected, validated, and signed without a vector store:

```bash
vex inspect memories.vmig.jsonl   # stats, namespaces, dimensions
vex validate memories.vmig.jsonl  # lint all records
vex sign memories.vmig.jsonl      # BLAKE3 + Ed25519 signature
vex verify memories.vmig.jsonl    # exit 0=valid, 1=tampered
```

---

## Install Optional Connector Dependencies

```bash
# Redis
npm install redis

# Milvus / Zilliz Cloud
npm install @zilliz/milvus2-sdk-node

# Neo4j / Aura
npm install neo4j-driver

# PostgreSQL / pgvector / Supabase
npm install pg

# LangChain integration
npm install @langchain/core
```

---

## Related

- [VEKTOR Slipstream](https://vektormemory.com) — local-first persistent memory SDK for AI agents

---

## License

Apache 2.0 — [vektormemory.com](https://vektormemory.com)
