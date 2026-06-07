#!/usr/bin/env node
import { getConnector }                          from './connectors/index.js';
import { writeMeta, readJsonl, validate }        from './formats/vmig.js';
import { streamExport, streamImport, migrate as coreMigrate } from './core/migrate.js';
import { listAdapters }                          from './utils/adapt.js';
import { signExport, verifyExport }              from './core/sign.js';
import { getAdapter as getConvertAdapter, listConvertAdapters } from './adapters/convert/index.js';
import { runPipeline }                          from './pipeline/index.js';
import fs                                        from 'fs';
import readline                                  from 'readline';

const _ = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  white:  '\x1b[97m',
  silver: '\x1b[37m',
  grey:   '\x1b[90m',
  navy:   '\x1b[38;5;17m',
  cobalt: '\x1b[38;5;26m',
  steel:  '\x1b[38;5;67m',
  sky:    '\x1b[38;5;117m',
  ice:    '\x1b[38;5;153m',
  powder: '\x1b[38;5;189m',
  green:  '\x1b[38;5;78m',
  red:    '\x1b[38;5;203m',
  amber:  '\x1b[38;5;221m',
};

const p  = (col, s) => `${col}${s}${_.reset}`;
const W  = s => p(_.white + _.bold, s);
const Si = s => p(_.silver, s);
const Gr = s => p(_.grey, s);
const Sk = s => p(_.sky, s);
const Ic = s => p(_.ice, s);
const St = s => p(_.steel, s);
const G  = s => p(_.green, s);
const R  = s => p(_.red, s);
const Y  = s => p(_.amber, s);
const Co = s => p(_.cobalt, s);

const VERSION = '0.8.4';

function banner() {
  console.log('');
  console.log(Co('  \u2588\u2588\u2557   \u2588\u2588\u2557') + St('\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557') + Sk('\u2588\u2588\u2557  \u2588\u2588\u2557'));
  console.log(Co('  \u2588\u2588\u2551   \u2588\u2588\u2551') + St('\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255d') + Sk('\u255a\u2588\u2588\u2557\u2588\u2588\u2554\u255d'));
  console.log(Co('  \u2588\u2588\u2551   \u2588\u2588\u2551') + St('\u2588\u2588\u2588\u2588\u2588\u2557  ') + Sk(' \u255a\u2588\u2588\u2588\u2554\u255d '));
  console.log(Co('  \u255a\u2588\u2588\u2557 \u2588\u2588\u2554\u255d') + St('\u2588\u2588\u2554\u2550\u2550\u255d  ') + Sk(' \u2588\u2588\u2554\u2588\u2588\u2557 '));
  console.log(Co('   \u255a\u2588\u2588\u2588\u2588\u2554\u255d ') + St('\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557') + Sk('\u2588\u2588\u2554\u255d \u2588\u2588\u2557') + '  ' + Gr(`v${VERSION}`));
  console.log(Co('    \u255a\u2550\u2550\u2550\u255d  ') + St('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u255d') + Sk('\u255a\u2550\u255d  \u255a\u2550\u255d'));
  console.log('');
  console.log('  ' + W('Vector Exchange') + Gr('  \u00b7  Apache 2.0  \u00b7  github.com/Vektor-Memory/Vex'));
  console.log('');
}

const BAR = St('\u2502');
const TL  = St('\u250c\u2500');
const BL  = St('\u2514');
const HR  = St('\u2500');

function box(label) {
  console.log('  ' + TL + ' ' + Ic(label) + ' ' + HR.repeat(Math.max(2, 44 - label.length)));
}
function boxEnd() {
  console.log('  ' + BL + HR.repeat(47));
  console.log('');
}
function row(label, value) {
  const raw = label.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = ' '.repeat(Math.max(1, 18 - raw.length));
  console.log('  ' + BAR + '  ' + label + pad + value);
}
function blank() {
  console.log('  ' + BAR);
}

function showHelp() {
  banner();

  box('COMMANDS');
  row(W('export'),   Sk('vex export')    + Gr('  --from <store>  --output <file.vmig.jsonl>'));
  row(W('import'),   Sk('vex import')    + Gr('  --from <file>   --to <store>'));
  row(W('migrate'),  Sk('vex migrate')   + Gr('  --from <store>  --to <store>'));
  row(W('convert'),  Sk('vex convert')   + Gr('  --from <file.vmig.jsonl>  --adapter <name>  --output <file>'));
  row(W('sign'),     Sk('vex sign')      + Gr('  <file>  \u2014 BLAKE3 + Ed25519 sign export'));
  row(W('verify'),   Sk('vex verify')    + Gr('  <file>  \u2014 verify signature (exit 0=ok 1=tampered)'));
  row(W('inspect'),  Sk('vex inspect')   + Gr('  <file>  \u2014 show stats, models, namespaces'));
  row(W('validate'), Sk('vex validate')  + Gr('  <file>  \u2014 lint all records'));
  row(W('adapters'), Sk('vex adapters')  + Gr('  \u2014 list available vec2vec projection pairs'));
  boxEnd();

  box('CONNECTORS');
  row(G('\u2713') + ' ' + W('vektor'),         Si('VEKTOR Slipstream SQLite   ') + Ic('export \u00b7 import'));
  row(G('\u2713') + ' ' + W('jsonl'),          Si('.vmig.jsonl file           ') + Ic('export \u00b7 import'));
  row(G('\u2713') + ' ' + W('pinecone'),       Si('Pinecone                   ') + Ic('export \u00b7 import'));
  row(G('\u2713') + ' ' + W('qdrant'),         Si('Qdrant                     ') + Ic('export \u00b7 import'));
  row(G('\u2713') + ' ' + W('chroma'),         Si('ChromaDB                   ') + Ic('export \u00b7 import'));
  row(G('\u2713') + ' ' + W('weaviate'),       Si('Weaviate                   ') + Ic('export \u00b7 import'));
  row(G('\u2713') + ' ' + W('pgvector'),       Si('PostgreSQL / pgvector       ') + Ic('export \u00b7 import'));
  row(G('\u2713') + ' ' + W('redis'),          Si('Redis / Redis Stack         ') + Ic('export \u00b7 import'));
  row(G('\u2713') + ' ' + W('milvus'),         Si('Milvus / Zilliz Cloud        ') + Ic('export \u00b7 import'));
  row(G('\u2713') + ' ' + W('neo4j'),          Si('Neo4j / Aura                ') + Ic('export \u00b7 import'));
  row(G('\u2713') + ' ' + W('claude-export'),  Si('Claude conversation JSON    ') + Ic('export only'));
  row(G('\u2713') + ' ' + W('chatgpt-export'), Si('ChatGPT conversation JSON   ') + Ic('export only'));
  boxEnd();

  box('CONVERT ADAPTERS');
  row(G('\u2713') + ' ' + W('openai-finetune'),    Si('OpenAI fine-tuning JSONL     ') + Ic('POST /v1/fine_tuning/jobs'));
  row(G('\u2713') + ' ' + W('openai-context'),     Si('OpenAI chat messages JSON    ') + Ic('context injection'));
  row(G('\u2713') + ' ' + W('generic-chat'),       Si('Generic {role,content} JSONL ') + Ic('Perplexity \u00b7 Groq \u00b7 Mistral \u00b7 Together'));
  row(G('\u2713') + ' ' + W('anthropic-finetune'), Si('Anthropic Messages format     ') + Ic('Messages API / fine-tune'));
  row(G('\u2713') + ' ' + W('plain-text'),         Si('Human-readable transcript     ') + Ic('.txt'));
  blank();
  console.log('  ' + BAR + '  ' + Gr('  Aliases: perplexity, groq, mistral, together \u2192 generic-chat'));
  console.log('  ' + BAR + '  ' + Gr('           anthropic \u2192 anthropic-finetune  |  txt \u2192 plain-text'));
  boxEnd();

  box('COMMON FLAGS');
  row(Sk('--namespace'),     Gr('<ns>     filter by namespace on export'));
  row(Sk('--components'),    Gr('<types>  filter by memory_type: working,semantic,procedural,episodic,identity'));
  row(Sk('--limit'),         Gr('<n>      max records to export'));
  row(Sk('--output'),        Gr('<file>   destination .vmig.jsonl'));
  row(Sk('--db'),            Gr('<path>   VEKTOR SQLite DB path'));
  row(Sk('--sign'),          G('v0.4') + Gr('   auto-sign after export (BLAKE3 + Ed25519)'));
  row(Sk('--reembed'),       Gr('         re-embed dim-mismatched records from text'));
  row(Sk('--adapter'),       G('vec2vec') + Gr(' translate embeddings \u2014 no API required'));
  row(Sk('--adapter-model'), Gr('<model>  target model name for --adapter'));
  row(Sk('--embed-model'),   Gr('<model>  model for --reembed (default: text-embedding-3-small)'));
  boxEnd();

  box('CONVERSATION EXPORT FLAGS  (claude-export \u00b7 chatgpt-export)');
  row(Sk('--file'),              Gr('<path>   conversations.json from export'));
  row(Sk('--mode'),              G('\u2605') + Gr('  raw | extract | smart  (default: raw)'));
  row(Sk('--chunk-mode'),        Gr('turn | conversation | exchange  (default: conversation)'));
  row(Sk('--sender'),            Gr('both | user | assistant  (default: both)'));
  row(Sk('--max-chars'),         Gr('<n>      split long conversations at N chars'));
  row(Sk('--after'),             Gr('<ISO date>  only conversations after this date'));
  row(Sk('--before'),            Gr('<ISO date>  only conversations before this date'));
  row(Sk('--limit-convs'),       Gr('<n>      max conversations to process'));
  row(Sk('--conversation-name'), Gr('<str>    filter by conversation name (substring)'));
  row(Sk('--embed-url'),         Gr('<url>    custom embedding endpoint (OpenAI-compatible)'));
  row(Sk('--embed-key'),         Gr('<key>    API key for --embed-url'));
  boxEnd();

  box('EXTRACTION FLAGS  (--mode extract | smart)');
  row(Sk('--provider'),          G('auto') + Gr(' auto|groq,ollama,openai  \u2014 cascade order (default: auto)'));
  row(Sk('--groq-key'),          G('free') + Gr('  key1,key2,key3  \u2014 Groq keys rotated round-robin'));
  row(Sk('--openai-key'),        Gr('<key>    OpenAI API key  \u2014 gpt-4o-mini'));
  row(Sk('--anthropic-key'),     Gr('<key>    Anthropic API key  \u2014 claude-haiku'));
  row(Sk('--mistral-key'),       Gr('<key>    Mistral API key  \u2014 mistral-small'));
  row(Sk('--together-key'),      Gr('<key>    Together.ai key  \u2014 Llama-3.2-3B'));
  row(Sk('--ollama-url'),        Gr('<url>    Ollama URL  \u2014 local, unlimited, free'));
  row(Sk('--ollama-draft'),      G('fast') + Gr(' <model>  spec decoding draft model (2-4x speed)'));
  row(Sk('--extract-url'),       Gr('<url>    Custom OpenAI-compatible endpoint'));
  row(Sk('--extract-model'),     Gr('<model>  groq:llama-3.3-70b,ollama:mistral or global'));
  row(Sk('--extract-key'),       Gr('<key>    API key for --extract-url'));
  row(Sk('--min-importance'),    Gr('<0-1>    Importance filter threshold (default: 0.5)'));
  row(Sk('--concurrency'),       Gr('<n>      Parallel LLM calls (default: 3, use 1 for free Groq)'));
  row(Sk('--rate-limit'),        Gr('<ms>     Fixed delay between batches (overrides adaptive)'));
  row(Sk('--dry-run'),           Y('preview') + Gr(' Show extracted facts without storing'));
  boxEnd();

  box('PROVIDER CASCADE  (--mode extract)');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Auto-chain from vektor config (reads all configured keys)'));
  console.log('  ' + BAR + '  ' + Sk('vex migrate') + ' --from claude-export --to vektor --file convs.json --db mem.db \\');
  console.log('  ' + BAR + '  ' + Gr('             --mode extract --provider auto'));
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Explicit cascade: Groq first, fall to Ollama if rate-limited'));
  console.log('  ' + BAR + '  ' + Sk('vex migrate') + ' ... --provider groq,ollama --groq-key $KEY --ollama-url http://localhost:11434');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Key rotation: 3 Groq keys (triples effective TPM budget)'));
  console.log('  ' + BAR + '  ' + Sk('vex migrate') + ' ... --provider groq --groq-key $KEY1,$KEY2,$KEY3');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Spec decoding: Ollama draft model for 2-4x speed'));
  console.log('  ' + BAR + '  ' + Sk('vex migrate') + ' ... --provider ollama --ollama-url http://localhost:11434 \\');
  console.log('  ' + BAR + '  ' + Gr('             --ollama-draft llama3.2 --extract-model llama3.1'));
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Override model per provider'));
  console.log('  ' + BAR + '  ' + Sk('vex migrate') + ' ... --extract-model groq:llama-3.3-70b-versatile,ollama:mistral');
  blank();
  boxEnd();

  box('CONVERT FLAGS');
  row(Sk('--from'),            Gr('<file.vmig.jsonl>  input file'));
  row(Sk('--adapter'),         Gr('<name>   openai-finetune | openai-context | generic-chat | anthropic-finetune | plain-text'));
  row(Sk('--output'),          Gr('<file>   output path (extension auto-appended if omitted)'));
  row(Sk('--system-prompt'),   Gr('<text>   prepend system message (openai-* and anthropic-*)'));
  row(Sk('--max-tokens'),      Gr('<n>      token budget hint for openai-context (approx)'));
  row(Sk('--conversation-id'), Gr('<id>   filter to single conversation (openai-context)'));
  row(Sk('--separator'),       Gr('<str>    section separator for plain-text (default: \u2550\u00d772)'));
  blank();
  console.log('  ' + BAR + '  ' + Sk('vex convert --adapter list') + Gr('  \u2014 show all adapters'));
  boxEnd();

  box('SIGN / VERIFY  (v0.4)');
  row(Sk('--key'), Gr('<path>  private key file (auto-generated if missing)'));
  row(Sk('--sig'), Gr('<path>  .vmig.sig file (default: <file>.vmig.sig)'));
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Sign an export (generates .vmig.sig + .vmig.key)'));
  console.log('  ' + BAR + '  ' + Sk('vex sign') + ' memories.vmig.jsonl');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Verify integrity (exits 0=valid, 1=tampered)'));
  console.log('  ' + BAR + '  ' + Sk('vex verify') + ' memories.vmig.jsonl');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Export + auto-sign in one step'));
  console.log('  ' + BAR + '  ' + Sk('vex export') + ' --from vektor --db memory.db --output mem.vmig.jsonl --sign');
  boxEnd();

  box('PINECONE OPTIONS');
  row(Sk('--api-key'),   Gr('<key>   or ') + Ic('PINECONE_API_KEY'));
  row(Sk('--index'),     Gr('<name>  or ') + Ic('PINECONE_INDEX'));
  row(Sk('--host'),      Gr('<url>   or ') + Ic('PINECONE_HOST'));
  row(Sk('--namespace'), Gr('<ns>    optional'));
  boxEnd();

  box('QDRANT OPTIONS');
  row(Sk('--url'),         Gr('<url>   or ') + Ic('QDRANT_URL') + Gr('  default: http://localhost:6333'));
  row(Sk('--collection'),  Gr('<name>  or ') + Ic('QDRANT_COLLECTION'));
  row(Sk('--api-key'),     Gr('<key>   or ') + Ic('QDRANT_API_KEY') + Gr('  optional'));
  row(Sk('--auto-create'), Gr('auto-create collection if missing (default: true)'));
  boxEnd();

  box('CHROMA OPTIONS');
  row(Sk('--url'),        Gr('<url>   or ') + Ic('CHROMA_URL') + Gr('  default: http://localhost:8000'));
  row(Sk('--collection'), Gr('<name>  or ') + Ic('CHROMA_COLLECTION'));
  row(Sk('--tenant'),     Gr('<name>  optional, default: default_tenant'));
  row(Sk('--database'),   Gr('<name>  optional, default: default_database'));
  boxEnd();

  box('WEAVIATE OPTIONS');
  row(Sk('--url'),        Gr('<url>   or ') + Ic('WEAVIATE_URL') + Gr('  default: http://localhost:8080'));
  row(Sk('--collection'), Gr('<class> or ') + Ic('WEAVIATE_CLASS'));
  row(Sk('--api-key'),    Gr('<key>   or ') + Ic('WEAVIATE_API_KEY') + Gr('  optional'));
  boxEnd();

  box('PGVECTOR OPTIONS');
  row(Sk('--url'),   Gr('<postgres://...>  or ') + Ic('PGVECTOR_URL'));
  row(Sk('--table'), Gr('<name>            or ') + Ic('PGVECTOR_TABLE') + Gr('  default: vex_vectors'));
  boxEnd();

  box('REDIS OPTIONS');
  row(Sk('--redis-url'), Gr('<url>   or ') + Ic('REDIS_URL') + Gr('  default: redis://localhost:6379'));
  row(Sk('--index'),     Gr('<name>  RediSearch index name  default: vex-memory'));
  boxEnd();

  box('MILVUS OPTIONS');
  row(Sk('--milvus-url'),   Gr('<url>   or ') + Ic('MILVUS_URL') + Gr('  default: localhost:19530'));
  row(Sk('--milvus-token'), Gr('<key>   or ') + Ic('MILVUS_TOKEN') + Gr('  (Zilliz Cloud)'));
  row(Sk('--collection'),   Gr('<name>  collection name  default: vex_memory'));
  boxEnd();

  box('NEO4J OPTIONS');
  row(Sk('--neo4j-url'),      Gr('<url>   or ') + Ic('NEO4J_URL') + Gr('  default: bolt://localhost:7687'));
  row(Sk('--neo4j-user'),     Gr('<user>  or ') + Ic('NEO4J_USER') + Gr('  default: neo4j'));
  row(Sk('--neo4j-password'), Gr('<pass>  or ') + Ic('NEO4J_PASSWORD'));
  boxEnd();

  box('RE-EMBED / ADAPTER');
  row(Sk('--reembed'),       Gr('re-embed via OpenAI or Ollama on dim mismatch'));
  row(Sk('--openai-key'),    Gr('<key>  or ') + Ic('OPENAI_API_KEY'));
  row(Sk('--ollama-url'),    Gr('<url>  or ') + Ic('OLLAMA_URL') + Gr('  prefix model with ollama:'));
  row(Sk('--adapter'),       G('vec2vec') + Gr('  translate without re-embedding (needs vex-adapter)'));
  row(Sk('--adapter-model'), Gr('target model name for vec2vec projection'));
  boxEnd();

  box('EXAMPLES');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Export VEKTOR memory'));
  console.log('  ' + BAR + '  ' + Sk('vex export') + ' --from vektor --db memory.db --output memories.vmig.jsonl');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Migrate Claude conversations with LLM fact extraction'));
  console.log('  ' + BAR + '  ' + Sk('vex migrate') + ' --from claude-export --to vektor --file conversations.json \\');
  console.log('  ' + BAR + '  ' + Gr('             --db memory.db --mode smart --openai-key $KEY --namespace my-history'));
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Migrate VEKTOR \u2192 Redis'));
  console.log('  ' + BAR + '  ' + Sk('vex migrate') + ' --from vektor --to redis --db memory.db --redis-url redis://localhost:6379');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Migrate VEKTOR \u2192 Neo4j'));
  console.log('  ' + BAR + '  ' + Sk('vex migrate') + ' --from vektor --to neo4j --db memory.db --neo4j-url bolt://localhost:7687');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Migrate VEKTOR \u2192 Milvus'));
  console.log('  ' + BAR + '  ' + Sk('vex migrate') + ' --from vektor --to milvus --db memory.db --milvus-url localhost:19530');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Migrate VEKTOR \u2192 pgvector / Supabase'));
  console.log('  ' + BAR + '  ' + Sk('vex migrate') + ' --from vektor --to pgvector --db memory.db --url postgres://user:pass@localhost/db');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Export + sign'));
  console.log('  ' + BAR + '  ' + Sk('vex export') + ' --from vektor --db memory.db --output mem.vmig.jsonl --sign');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Verify before importing'));
  console.log('  ' + BAR + '  ' + Sk('vex verify') + ' memories.vmig.jsonl && ' + Sk('vex import') + ' --from memories.vmig.jsonl --to qdrant --collection mem');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Inspect a file'));
  console.log('  ' + BAR + '  ' + Sk('vex inspect') + ' memories.vmig.jsonl');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Dry run: preview extracted facts without writing to DB'));
  console.log('  ' + BAR + '  ' + Sk('vex migrate') + ' --from claude-export --to vektor --file conversations.json \\');
  console.log('  ' + BAR + '  ' + Gr('             --db memory.db --mode extract --groq-key $GROQ_KEY --dry-run'));
  blank();
  console.log('  ' + BAR + '  ' + Gr('# List all convert adapters'));
  console.log('  ' + BAR + '  ' + Sk('vex convert') + ' --adapter list');
  blank();
  boxEnd();
}

async function cmdInspect(file) {
  if (!file || !fs.existsSync(file)) {
    console.error('\n' + R(`  \u2717  File not found: ${file || '(none provided)'}`)); process.exit(1);
  }
  banner();
  console.log('  ' + Gr(`Inspecting: ${file}`) + '\n');

  const records = await readJsonl(file);
  if (!records.length) { console.log(Y('  \u26a0   File is empty')); return; }

  const models = {}, dims = {}, namespaces = {}, stores = {};
  let nullVec = 0, nullText = 0;
  const dates = records.map(r => r.created_at).filter(Boolean).sort();

  for (const r of records) {
    if (!r.vector) nullVec++;
    if (!r.text)   nullText++;
    if (r.model)        models[r.model]        = (models[r.model]        || 0) + 1;
    if (r.dims)         dims[String(r.dims)]   = (dims[String(r.dims)]   || 0) + 1;
    if (r.namespace)    namespaces[r.namespace] = (namespaces[r.namespace]|| 0) + 1;
    if (r.source_store) stores[r.source_store]  = (stores[r.source_store] || 0) + 1;
  }

  const metaPath = file.replace(/\.vmig\.jsonl$/, '.vmig.meta.json');
  let meta = null;
  if (fs.existsSync(metaPath)) try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}

  box('FILE SUMMARY');
  row(Si('records'),     W(String(records.length)));
  row(Si('with vector'), G(String(records.length - nullVec))  + (nullVec  ? '  ' + Y(`(${nullVec} null)`)  : ''));
  row(Si('with text'),   G(String(records.length - nullText)) + (nullText ? '  ' + Y(`(${nullText} null)`) : ''));
  if (dates.length) {
    row(Si('earliest'), Gr(dates[0]));
    row(Si('latest'),   Gr(dates[dates.length - 1]));
  }
  if (meta) {
    row(Si('checksum'),    Gr(meta.checksum    || '\u2014'));
    row(Si('exported at'), Gr(meta.exported_at || '\u2014'));
    if (meta.imported_to) row(Si('imported to'), Ic(meta.imported_to) + Gr(' @ ' + meta.imported_at));
  }
  boxEnd();

  if (Object.keys(models).length)     { box('MODELS');     for (const [m,n] of Object.entries(models))      row(Si(m),         Gr(`${n} records`)); boxEnd(); }
  if (Object.keys(dims).length)       { box('DIMENSIONS'); for (const [d,n] of Object.entries(dims))        row(Si(`${d}-dim`), Gr(`${n} records`)); boxEnd(); }
  if (Object.keys(namespaces).length) { box('NAMESPACES'); for (const [ns,n] of Object.entries(namespaces)) row(Si(ns),        Gr(`${n} records`)); boxEnd(); }
  if (Object.keys(stores).length)     { box('SOURCES');    for (const [s,n] of Object.entries(stores))      row(Si(s),         Gr(`${n} records`)); boxEnd(); }
}

async function cmdValidate(file) {
  if (!file || !fs.existsSync(file)) {
    console.error('\n' + R(`  \u2717  File not found: ${file || '(none provided)'}`)); process.exit(1);
  }
  banner();
  console.log('  ' + Gr(`Validating: ${file}`) + '\n');

  const records = await readJsonl(file);
  let errors = 0, warnings = 0;

  box(`VALIDATION  (${records.length} records)`);

  for (let i = 0; i < records.length; i++) {
    const errs = validate(records[i]);
    if (errs.length) {
      errors++;
      console.log('  ' + BAR + '  ' + R(`\u2717  [${i}] id=${records[i].id ?? '?'}`));
      for (const e of errs) console.log('  ' + BAR + '     ' + Gr(`\u2192 ${e}`));
    }
    if (!records[i].vector && records[i].text) {
      warnings++;
      console.log('  ' + BAR + '  ' + Y(`\u26a0   [${i}] no vector \u2014 re-embeddable from text`));
    }
  }

  if (!errors && !warnings)
    console.log('  ' + BAR + '  ' + G(`\u2713  All ${records.length} records valid`));

  boxEnd();
  box('RESULT');
  row(Si('records'),  W(String(records.length)));
  row(Si('errors'),   errors   ? R(String(errors))   : G('0'));
  row(Si('warnings'), warnings ? Y(String(warnings)) : G('0'));
  row(Si('status'),   errors   ? R('\u2717  INVALID') : G('\u2713  VALID'));
  boxEnd();

  if (errors) process.exit(1);
}

async function cmdAdapters() {
  banner();
  box('VEX-ADAPTER  PROJECTION PAIRS');
  try {
    const pairs = await listAdapters();
    if (typeof pairs === 'string') {
      console.log('  ' + BAR + '  ' + Y(pairs));
    } else if (Array.isArray(pairs)) {
      if (!pairs.length) {
        console.log('  ' + BAR + '  ' + Gr('No projection pairs available.'));
      } else {
        for (const [src, tgt] of pairs) {
          row(Ic(src), Gr('\u2192  ') + Sk(tgt));
        }
      }
    }
  } catch (e) {
    console.log('  ' + BAR + '  ' + R(e.message));
    console.log('  ' + BAR + '  ' + Gr('Install with: npm install @vektormemory/vex-adapter'));
  }
  boxEnd();
}

async function cmdSign(file, flags) {
  if (!file || !fs.existsSync(file)) {
    console.error(R(`\n  \u2717  File not found: ${file || '(none provided)'}`)); process.exit(1);
  }
  banner();
  console.log('  ' + G('\u2192') + '  Signing ' + Gr(file) + '\n');
  try {
    const sig = await signExport(file, { keyFile: flags.key || null, saveKey: true });
    console.log('\n  ' + G('\u2713') + '  ' + W(String(sig.record_count)) + ' records signed');
    console.log('  ' + G('\u2713') + '  Signature \u2192 ' + Gr(file.replace(/\.vmig\.jsonl$/, '.vmig.sig')) + '\n');
  } catch (err) {
    if (err.message.includes('@noble')) {
      console.error('\n' + Y('  \u26a0   Signing requires @noble packages:'));
      console.error(Y('     npm install @noble/hashes @noble/ed25519') + '\n');
    } else {
      console.error('\n' + R(`  \u2717  ${err.message}`));
    }
    process.exit(1);
  }
}

async function cmdVerify(file, flags) {
  if (!file || !fs.existsSync(file)) {
    console.error(R(`\n  \u2717  File not found: ${file || '(none provided)'}`)); process.exit(1);
  }
  banner();
  console.log('  ' + G('\u2192') + '  Verifying ' + Gr(file) + '\n');
  try {
    const result = await verifyExport(file, { sigFile: flags.sig || null });
    if (result.valid) {
      console.log('\n  ' + G('\u2713') + '  ' + W('Signature valid') + ' \u2014 file has not been tampered with\n');
      process.exit(0);
    } else {
      console.log('\n  ' + R('\u2717  Verification FAILED'));
      for (const e of result.errors) console.log('  ' + R('   \u2192 ') + Gr(e));
      console.log('');
      process.exit(1);
    }
  } catch (err) {
    if (err.message.includes('@noble')) {
      console.error('\n' + Y('  \u26a0   Verification requires @noble packages:'));
      console.error(Y('     npm install @noble/hashes @noble/ed25519') + '\n');
    } else {
      console.error('\n' + R(`  \u2717  ${err.message}`));
    }
    process.exit(1);
  }
}

async function cmdExport(flags) {
  if (!flags.from)   { console.error(R('\n  \u2717  --from required'));   process.exit(1); }
  if (!flags.output && !flags.o) { console.error(R('\n  \u2717  --output required')); process.exit(1); }

  const outPath   = flags.output || flags.o;
  const connector = getConnector(flags.from);

  if (flags.components) {
    const allowed = new Set(
      String(flags.components).toLowerCase().split(',').map(s => s.trim()).filter(Boolean)
    );
    const VALID_TYPES = new Set(['episodic', 'semantic', 'procedural', 'working', 'identity']);
    for (const t of allowed) {
      if (!VALID_TYPES.has(t)) {
        console.error(R(`\n  \u2717  Unknown component type: "${t}"`));
        console.error(Gr('     Valid types: episodic, semantic, procedural, working, identity'));
        process.exit(1);
      }
    }
    flags._componentFilter = allowed;
    console.log('  ' + G('\u2192') + '  Component filter: ' + Ic([...allowed].join(', ')));
  }

  banner();
  const nsLabel    = flags.namespace     ? Gr(` [ns: ${flags.namespace}]`)          : '';
  const limLabel   = flags.limit         ? Gr(` [limit: ${flags.limit}]`)            : '';
  const compLabel  = flags.components    ? Y(`  [components: ${flags.components}]`)  : '';
  const chunkLabel = flags['chunk-mode'] ? Gr(` [chunk: ${flags['chunk-mode']}]`)    : '';
  console.log('  ' + G('\u2192') + '  Exporting from ' + Ic(flags.from) + nsLabel + limLabel + compLabel + chunkLabel + '\n');

  let total = await streamExport(connector, flags, outPath);

  if (flags._componentFilter) {
    const allowed  = flags._componentFilter;
    const raw      = fs.readFileSync(outPath, 'utf8').split('\n').filter(l => l.trim());
    const filtered = raw.filter(line => {
      try {
        const r  = JSON.parse(line);
        const mt = (r.metadata?.memory_type || r.memory_type || 'semantic').toLowerCase();
        return allowed.has(mt);
      } catch { return false; }
    });
    fs.writeFileSync(outPath, filtered.join('\n') + '\n', 'utf8');
    total = filtered.length;
    console.log(`  ${G('\u2192')}  Component filter applied: ${total} records kept`);
  }

  await writeMeta(outPath, {
    source_store: flags.from,
    exported_at:  new Date().toISOString(),
    components:   flags.components || null,
  });

  console.log('\n  ' + G('\u2713') + '  ' + W(String(total)) + ' records exported \u2192 ' + Gr(outPath) + '\n');

  if (flags.sign) {
    console.log('  ' + G('\u2192') + '  Auto-signing...\n');
    try {
      await signExport(outPath, { keyFile: flags.key || null, saveKey: true });
      console.log('  ' + G('\u2713') + '  Signed \u2192 ' + Gr(outPath.replace(/\.vmig\.jsonl$/, '.vmig.sig')) + '\n');
    } catch (err) {
      console.warn(Y(`  \u26a0   Sign failed (install @noble/hashes @noble/ed25519): ${err.message}`));
    }
  }
}

async function cmdImport(flags) {
  if (!flags.from) { console.error(R('\n  \u2717  --from required')); process.exit(1); }
  if (!flags.to)   { console.error(R('\n  \u2717  --to required'));   process.exit(1); }
  if (!fs.existsSync(flags.from)) {
    console.error(R(`\n  \u2717  File not found: ${flags.from}`)); process.exit(1);
  }

  const connector = getConnector(flags.to);

  banner();
  const adapterLabel = flags.adapter ? G('  [vec2vec adapter]') : flags.reembed ? Y('  [reembed]') : '';
  console.log('  ' + G('\u2192') + '  ' + Gr(flags.from) + ' \u2192 ' + Ic(flags.to) + adapterLabel + '\n');

  const { total, upserted, skipped } = await streamImport(flags.from, connector, flags);

  writeMeta(flags.from, {
    imported_to: flags.to,
    imported_at: new Date().toISOString(),
  });

  console.log('\n  ' + G('\u2713') + '  ' + W(String(upserted)) + ' upserted' +
    (skipped ? '  ' + Y(`${skipped} skipped`) : '') + '\n');
}

async function cmdMigrate(flags) {
  if (!flags.from) { console.error(R('\n  \u2717  --from required')); process.exit(1); }
  if (!flags.to)   { console.error(R('\n  \u2717  --to required'));   process.exit(1); }

  const fromConnector = getConnector(flags.from);
  const toConnector   = getConnector(flags.to);
  const mode          = flags.mode || 'raw';

  const isPipelineSource = ['claude-export','chatgpt-export'].includes(flags.from);

  banner();
  const modeLabel    = Gr(`  [mode: ${mode}]`);
  const adapterLabel = flags.adapter ? G('  [vec2vec adapter]') : flags.reembed ? Y('  [reembed]') : '';
  const chunkLabel   = flags['chunk-mode'] ? Gr(`  [chunk: ${flags['chunk-mode']}]`) : '';
  console.log('  ' + G('\u2192') + '  Migrating ' + Ic(flags.from) + ' \u2192 ' + Ic(flags.to) + modeLabel + adapterLabel + chunkLabel + '\n');

  if (isPipelineSource) {
    const filePath = flags.file || flags.from;
    if (!fs.existsSync(filePath)) throw new Error('--file <conversations.json> required');
    const raw  = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.conversations) ? raw.conversations : []);

    const conversations = list.map(conv => {
      const msgs = (conv.chat_messages || conv.messages || []).map(m => ({
        id:   m.uuid || m.id || crypto.randomUUID(),
        role: (m.sender === 'human' || m.role === 'user') ? 'user' : 'assistant',
        text: typeof m.text === 'string' ? m.text : (typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.filter(b=>b.type==='text').map(b=>b.text).join('\n') : '')),
        created_at: m.created_at || null,
      })).filter(m => m.text && m.text.trim());
      return {
        id:         conv.uuid || conv.id || crypto.randomUUID(),
        name:       conv.name || conv.title || 'Untitled',
        created_at: conv.created_at || conv.updated_at || null,
        messages:   msgs,
      };
    });

    const limitConvs    = flags['limit-convs'] ? parseInt(flags['limit-convs']) : null;
    const pipelineConvs = limitConvs ? conversations.slice(0, limitConvs) : conversations;
    process.stdout.write('[pipeline] processing ' + pipelineConvs.length + ' conversations' + (limitConvs ? ' (limited from ' + conversations.length + ')' : '') + '\n');
    const result = await runPipeline(pipelineConvs, toConnector, { ...flags, mode });

    if (result.dryRun) {
      console.log('\n  ' + Y('\u26a0   DRY RUN') + '  ' + W(String(result.facts)) + ' facts would be extracted, ' + W(String(result.edges)) + ' edges\n');
    } else {
      console.log('\n  ' + G('\u2713') + '  ' + W(String(result.upserted)) + ' facts stored' +
        (result.skipped ? '  ' + Y(`${result.skipped} skipped`) : '') +
        '  ' + Gr(`${result.edges} edges`) + '\n');
    }
    return;
  }

  const { total, upserted, skipped } = await coreMigrate(fromConnector, toConnector, flags);
  const _skStr = skipped > 0 ? ' (' + skipped + ' duplicate/skipped)' : '';
  console.log('\n  ' + G('\u2713') + '  ' + W(String(upserted)) + ' new records written' + _skStr + ' / ' + String(total) + ' total\n');
}

async function cmdConvert(flags) {
  if (!flags.adapter) { console.error(R('\n  \u2717  --adapter required (try --adapter list)')); process.exit(1); }

  if (flags.adapter === 'list') {
    banner();
    box('CONVERT ADAPTERS');
    const adapters = listConvertAdapters();
    for (const a of adapters) {
      const nameCol = W(a.name.padEnd(22));
      const extCol  = Ic(`.${a.ext}  `);
      const descCol = Gr(a.description.length > 58 ? a.description.slice(0, 55) + '\u2026' : a.description);
      row(nameCol, extCol + descCol);
    }
    blank();
    console.log('  ' + BAR + '  ' + Gr('Aliases: perplexity / groq / mistral / together \u2192 generic-chat'));
    console.log('  ' + BAR + '  ' + Gr('         anthropic \u2192 anthropic-finetune  |  txt \u2192 plain-text'));
    boxEnd();
    return;
  }

  if (!flags.from)               { console.error(R('\n  \u2717  --from required'));    process.exit(1); }
  if (!flags.output && !flags.o) { console.error(R('\n  \u2717  --output required')); process.exit(1); }
  if (!fs.existsSync(flags.from)) {
    console.error(R(`\n  \u2717  File not found: ${flags.from}`)); process.exit(1);
  }

  let adapter;
  try {
    adapter = getConvertAdapter(flags.adapter);
  } catch (e) {
    console.error(R(`\n  \u2717  ${e.message}`));
    console.log('  Run ' + Sk('vex convert --adapter list') + ' to see available adapters.\n');
    process.exit(1);
  }

  banner();
  console.log('  ' + G('\u2192') + '  Converting ' + Gr(flags.from) + ' \u2192 ' + Ic(adapter.name) + '\n');

  const records = await readJsonl(flags.from);
  if (!records.length) { console.error(Y('\n  \u26a0   Input file is empty')); process.exit(1); }

  box('CONVERT');
  row(Si('records'),    W(String(records.length)));
  row(Si('adapter'),    Ic(adapter.name));
  row(Si('output ext'), Gr('.' + adapter.fileExtension));
  if (flags['system-prompt']) row(Si('system prompt'), Gr(flags['system-prompt'].slice(0, 50) + (flags['system-prompt'].length > 50 ? '\u2026' : '')));
  if (flags['chunk-mode'])    row(Si('chunk mode'),    Gr(flags['chunk-mode']));
  boxEnd();

  const output    = adapter.convert(records, flags);
  const outPath   = flags.output || flags.o;
  const finalPath = outPath.includes('.') ? outPath : `${outPath}.${adapter.fileExtension}`;

  fs.writeFileSync(finalPath, output, 'utf8');

  const lineCount = output.trim().split('\n').filter(Boolean).length;
  console.log('  ' + G('\u2713') + '  ' + W(String(lineCount)) + ' lines written \u2192 ' + Gr(finalPath) + '\n');
}

async function interactiveMenu() {
  banner();
  console.log('  ' + W('No command given.') + Gr('  Run ') + Sk('vex --help') + Gr(' for full docs.\n'));

  const opts = [
    ['1', 'export',   'Export memory \u2192 .vmig.jsonl'],
    ['2', 'import',   'Import .vmig.jsonl \u2192 any store'],
    ['3', 'migrate',  'Migrate directly between stores'],
    ['4', 'convert',  'Convert .vmig.jsonl \u2192 LLM provider format'],
    ['5', 'sign',     'Sign export (BLAKE3 + Ed25519)'],
    ['6', 'verify',   'Verify signature'],
    ['7', 'inspect',  'Inspect a .vmig.jsonl file'],
    ['8', 'validate', 'Validate a .vmig.jsonl file'],
    ['9', 'adapters', 'List vec2vec projection pairs'],
    ['h', 'help',     'Full help'],
    ['q', 'quit',     ''],
  ];

  for (const [k, label, desc] of opts) {
    if (k === 'q') { console.log(''); continue; }
    console.log('  ' + Co(`[${k}]`) + '  ' + W(label.padEnd(12)) + Gr(desc));
  }
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('  ' + Sk('\u2192') + '  ', answer => {
    rl.close();
    const map = {
      '1':'export','2':'import','3':'migrate','4':'convert',
      '5':'sign','6':'verify','7':'inspect','8':'validate','9':'adapters',
    };
    const ch = answer.trim().toLowerCase();
    console.log('');
    if (ch === 'h') { showHelp(); return; }
    if (ch === 'q' || !ch) process.exit(0);
    if (map[ch]) console.log('  ' + G('\u2713') + '  Run: ' + Sk(`vex ${map[ch]} --help`) + '\n');
    else         console.log('  ' + R('\u2717') + '  Unknown option.\n');
  });
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key  = argv[i].slice(2);
      const next = argv[i + 1];
      flags[key] = (!next || next.startsWith('--')) ? true : next;
      if (next && !next.startsWith('--')) i++;
    }
  }
  return flags;
}

const args  = process.argv.slice(2);
const cmd   = args[0];
const flags = parseFlags(args);

try {
  if (!cmd)                                      { await interactiveMenu();                                     }
  else if (['--help','-h','help'].includes(cmd)) { showHelp();                                                  }
  else if (['--version','-v'].includes(cmd))     { console.log(`vex v${VERSION}`);                              }
  else if (cmd === 'sign')                       { await cmdSign(args[1] || flags.file || flags.from, flags);   }
  else if (cmd === 'verify')                     { await cmdVerify(args[1] || flags.file || flags.from, flags); }
  else if (cmd === 'inspect')                    { await cmdInspect(args[1] || flags.file || flags.from);       }
  else if (cmd === 'validate')                   { await cmdValidate(args[1] || flags.file || flags.from);      }
  else if (cmd === 'adapters')                   { await cmdAdapters();                                         }
  else if (cmd === 'export')                     { await cmdExport(flags);                                      }
  else if (cmd === 'import')                     { await cmdImport(flags);                                      }
  else if (cmd === 'migrate')                    { await cmdMigrate(flags);                                     }
  else if (cmd === 'convert')                    { await cmdConvert(flags);                                     }
  else {
    console.error(R(`\n  \u2717  Unknown command: ${cmd}`));
    console.log('  Run ' + Sk('vex --help') + ' to see available commands.\n');
    process.exit(1);
  }
} catch (err) {
  console.error('\n' + R(`  \u2717  ${err.message}`));
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
}
