#!/usr/bin/env node
import { getConnector }                          from './connectors/index.js';
import { writeMeta, readJsonl, validate }        from './formats/vmig.js';
import { streamExport, streamImport, migrate as coreMigrate } from './core/migrate.js';
import { listAdapters }                          from './utils/adapt.js';
import { signExport, verifyExport }              from './core/sign.js';
import { getAdapter as getConvertAdapter, listConvertAdapters } from './adapters/convert/index.js';
import fs                                        from 'fs';
import readline                                  from 'readline';

// ── PALETTE ────────────────────────────────────────────────────────────────
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

const VERSION = '0.7.0';

// ── BANNER ─────────────────────────────────────────────────────────────────
function banner() {
  console.log('');
  console.log(Co('  ██╗   ██╗') + St('███████╗') + Sk('██╗  ██╗'));
  console.log(Co('  ██║   ██║') + St('██╔════╝') + Sk('╚██╗██╔╝'));
  console.log(Co('  ██║   ██║') + St('█████╗  ') + Sk(' ╚███╔╝ '));
  console.log(Co('  ╚██╗ ██╔╝') + St('██╔══╝  ') + Sk(' ██╔██╗ '));
  console.log(Co('   ╚████╔╝ ') + St('███████╗') + Sk('██╔╝ ██╗') + '  ' + Gr(`v${VERSION}`));
  console.log(Co('    ╚═══╝  ') + St('╚══════╝') + Sk('╚═╝  ╚═╝'));
  console.log('');
  console.log('  ' + W('Vector Exchange') + Gr('  ·  Apache 2.0  ·  github.com/Vektor-Memory/Vex'));
  console.log('');
}

// ── BOX HELPERS ────────────────────────────────────────────────────────────
const BAR = St('│');
const TL  = St('┌─');
const BL  = St('└');
const HR  = St('─');

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

// ── HELP ───────────────────────────────────────────────────────────────────
function showHelp() {
  banner();

  box('COMMANDS');
  row(W('export'),   Sk('vex export')    + Gr('  --from <store>  --output <file.vmig.jsonl>'));
  row(W('import'),   Sk('vex import')    + Gr('  --from <file>   --to <store>'));
  row(W('migrate'),  Sk('vex migrate')   + Gr('  --from <store>  --to <store>'));
  row(W('convert'),  Sk('vex convert')   + Gr('  --from <file.vmig.jsonl>  --adapter <name>  --output <file>'));
  row(W('sign'),     Sk('vex sign')      + Gr('  <file>  — BLAKE3 + Ed25519 sign export'));
  row(W('verify'),   Sk('vex verify')    + Gr('  <file>  — verify signature (exit 0=ok 1=tampered)'));
  row(W('inspect'),  Sk('vex inspect')   + Gr('  <file>  — show stats, models, namespaces'));
  row(W('validate'), Sk('vex validate')  + Gr('  <file>  — lint all records'));
  row(W('adapters'), Sk('vex adapters')  + Gr('  — list available vec2vec projection pairs'));
  boxEnd();

  box('CONNECTORS');
  row(G('✓') + ' ' + W('vektor'),        Si('VEKTOR Slipstream SQLite   ') + Ic('export · import'));
  row(G('✓') + ' ' + W('jsonl'),         Si('.vmig.jsonl file           ') + Ic('export · import'));
  row(G('✓') + ' ' + W('pinecone'),      Si('Pinecone                   ') + Ic('export · import'));
  row(G('✓') + ' ' + W('qdrant'),        Si('Qdrant                     ') + Ic('export · import'));
  row(G('✓') + ' ' + W('chroma'),        Si('ChromaDB                   ') + Ic('export · import'));
  row(G('✓') + ' ' + W('weaviate'),      Si('Weaviate                   ') + Ic('export · import'));
  row(G('✓') + ' ' + W('pgvector'),      Si('PostgreSQL / pgvector       ') + Ic('export · import'));
  row(G('✓') + ' ' + W('claude-export'), Si('Claude conversation JSON    ') + Ic('export only'));
  row(G('✓') + ' ' + W('chatgpt-export'),Si('ChatGPT conversation JSON   ') + Ic('export only'));
  boxEnd();

  box('CONVERT ADAPTERS');
  row(G('✓') + ' ' + W('openai-finetune'),    Si('OpenAI fine-tuning JSONL     ') + Ic('POST /v1/fine_tuning/jobs'));
  row(G('✓') + ' ' + W('openai-context'),     Si('OpenAI chat messages JSON    ') + Ic('context injection'));
  row(G('✓') + ' ' + W('generic-chat'),       Si('Generic {role,content} JSONL ') + Ic('Perplexity · Groq · Mistral · Together'));
  row(G('✓') + ' ' + W('anthropic-finetune'), Si('Anthropic Messages format     ') + Ic('Messages API / fine-tune'));
  row(G('✓') + ' ' + W('plain-text'),         Si('Human-readable transcript     ') + Ic('.txt'));
  blank();
  console.log('  ' + BAR + '  ' + Gr('  Aliases: perplexity, groq, mistral, together → generic-chat'));
  console.log('  ' + BAR + '  ' + Gr('           anthropic → anthropic-finetune  |  txt → plain-text'));
  boxEnd();

  box('COMMON FLAGS');
  row(Sk('--namespace'),     Gr('<ns>     filter by namespace on export'));
  row(Sk('--components'),    Gr('<types>  filter by memory_type: working,semantic,procedural,episodic,identity'));
  row(Sk('--limit'),         Gr('<n>      max records to export'));
  row(Sk('--output'),        Gr('<file>   destination .vmig.jsonl'));
  row(Sk('--db'),            Gr('<path>   VEKTOR SQLite DB path'));
  row(Sk('--sign'),          G('v0.4') + Gr('   auto-sign after export (BLAKE3 + Ed25519)'));
  row(Sk('--reembed'),       Gr('         re-embed dim-mismatched records from text'));
  row(Sk('--adapter'),       G('vec2vec') + Gr(' translate embeddings — no API required'));
  row(Sk('--adapter-model'), Gr('<model>  target model name for --adapter'));
  row(Sk('--embed-model'),   Gr('<model>  model for --reembed (default: text-embedding-3-small)'));
  boxEnd();

  box('CONVERSATION EXPORT FLAGS  (claude-export · chatgpt-export)');
  row(Sk('--file'),              Gr('<path>   conversations.json from export'));
  row(Sk('--chunk-mode'),        Gr('turn | conversation | exchange  (default: turn)'));
  row(Sk('--sender'),            Gr('both | user | assistant  (default: both)'));
  row(Sk('--after'),             Gr('<ISO date>  only conversations after this date'));
  row(Sk('--before'),            Gr('<ISO date>  only conversations before this date'));
  row(Sk('--limit-convs'),       Gr('<n>      max conversations to process'));
  row(Sk('--conversation-name'), Gr('<str>    filter by conversation name (substring)'));
  row(Sk('--embed-url'),         Gr('<url>    custom embedding endpoint (OpenAI-compatible)'));
  row(Sk('--embed-key'),         Gr('<key>    API key for --embed-url'));
  boxEnd();

  box('CONVERT FLAGS');
  row(Sk('--from'),          Gr('<file.vmig.jsonl>  input file'));
  row(Sk('--adapter'),       Gr('<name>   openai-finetune | openai-context | generic-chat | anthropic-finetune | plain-text'));
  row(Sk('--output'),        Gr('<file>   output path (extension auto-appended if omitted)'));
  row(Sk('--system-prompt'), Gr('<text>   prepend system message (openai-* and anthropic-*)'));
  row(Sk('--max-tokens'),    Gr('<n>      token budget hint for openai-context (approx)'));
  row(Sk('--conversation-id'), Gr('<id>   filter to single conversation (openai-context)'));
  row(Sk('--separator'),     Gr('<str>    section separator for plain-text (default: ═×72)'));
  blank();
  console.log('  ' + BAR + '  ' + Sk('vex convert --adapter list') + Gr('  — show all adapters'));
  boxEnd();

  box('SIGN / VERIFY  (v0.4)');
  row(Sk('--key'),     Gr('<path>  private key file (auto-generated if missing)'));
  row(Sk('--sig'),     Gr('<path>  .vmig.sig file (default: <file>.vmig.sig)'));
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
  console.log('  ' + BAR + '  ' + Gr('# Export ChatGPT conversations → vmig'));
  console.log('  ' + BAR + '  ' + Sk('vex export') + ' --from chatgpt-export --file conversations.json --output chatgpt.vmig.jsonl');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Migrate ChatGPT conversations directly into VEKTOR DB'));
  console.log('  ' + BAR + '  ' + Sk('vex migrate') + ' --from chatgpt-export --to vektor --file conversations.json --db memory.db');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Export Claude conversations → vmig'));
  console.log('  ' + BAR + '  ' + Sk('vex export') + ' --from claude-export --file conversations.json --output claude.vmig.jsonl');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Migrate Claude conversations directly into VEKTOR DB'));
  console.log('  ' + BAR + '  ' + Sk('vex migrate') + ' --from claude-export --to vektor --file conversations.json --db memory.db');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Convert to OpenAI fine-tuning format'));
  console.log('  ' + BAR + '  ' + Sk('vex convert') + ' --from claude.vmig.jsonl --adapter openai-finetune --output finetune.jsonl');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Convert to Perplexity / Groq / Mistral / Together (generic chat)'));
  console.log('  ' + BAR + '  ' + Sk('vex convert') + ' --from claude.vmig.jsonl --adapter generic-chat --output chat.jsonl');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Convert to Anthropic Messages API format'));
  console.log('  ' + BAR + '  ' + Sk('vex convert') + ' --from claude.vmig.jsonl --adapter anthropic-finetune --output anthropic.jsonl');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Convert to plain text transcript'));
  console.log('  ' + BAR + '  ' + Sk('vex convert') + ' --from claude.vmig.jsonl --adapter plain-text --output transcripts.txt');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Export with chunking + embedding'));
  console.log('  ' + BAR + '  ' + Sk('vex export') + ' --from claude-export --file conversations.json --output out.vmig.jsonl \\');
  console.log('  ' + BAR + '  ' + Gr('             --chunk-mode exchange --sender both --openai-key $KEY --namespace claude'));
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Export working + procedural memories only (PAM five-component model)'));
  console.log('  ' + BAR + '  ' + Sk('vex export') + ' --from vektor --db memory.db --components working,procedural --output state.vmig.jsonl');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Export specific namespace only'));
  console.log('  ' + BAR + '  ' + Sk('vex export') + ' --from vektor --db memory.db --namespace trading --output trading.vmig.jsonl');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Export from Qdrant'));
  console.log('  ' + BAR + '  ' + Sk('vex export') + ' --from qdrant --collection memories --output memories.vmig.jsonl');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Import into Pinecone'));
  console.log('  ' + BAR + '  ' + Sk('vex import') + ' --from memories.vmig.jsonl --to pinecone --api-key $KEY --index my-index --host $HOST');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Import with vec2vec projection (no re-embedding API needed)'));
  console.log('  ' + BAR + '  ' + Sk('vex import') + ' --from memories.vmig.jsonl --to qdrant --collection mem --adapter --adapter-model text-embedding-3-small');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Migrate Qdrant → VEKTOR'));
  console.log('  ' + BAR + '  ' + Sk('vex migrate') + ' --from qdrant --to vektor --collection memories --db memory.db');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Sign an export for tamper-evident transfer'));
  console.log('  ' + BAR + '  ' + Sk('vex sign') + ' memories.vmig.jsonl');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Verify before importing'));
  console.log('  ' + BAR + '  ' + Sk('vex verify') + ' memories.vmig.jsonl && vex import --from memories.vmig.jsonl --to qdrant --collection mem');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Inspect a file'));
  console.log('  ' + BAR + '  ' + Sk('vex inspect') + ' memories.vmig.jsonl');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# List all convert adapters'));
  console.log('  ' + BAR + '  ' + Sk('vex convert') + ' --adapter list');
  blank();
  boxEnd();
}

// ── INSPECT ────────────────────────────────────────────────────────────────
async function cmdInspect(file) {
  if (!file || !fs.existsSync(file)) {
    console.error('\n' + R(`  ✗  File not found: ${file || '(none provided)'}`)); process.exit(1);
  }
  banner();
  console.log('  ' + Gr(`Inspecting: ${file}`) + '\n');

  const records = await readJsonl(file);
  if (!records.length) { console.log(Y('  ⚠  File is empty')); return; }

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
    row(Si('checksum'),    Gr(meta.checksum    || '—'));
    row(Si('exported at'), Gr(meta.exported_at || '—'));
    if (meta.imported_to) row(Si('imported to'), Ic(meta.imported_to) + Gr(' @ ' + meta.imported_at));
  }
  boxEnd();

  if (Object.keys(models).length)     { box('MODELS');     for (const [m,n] of Object.entries(models))      row(Si(m),         Gr(`${n} records`)); boxEnd(); }
  if (Object.keys(dims).length)       { box('DIMENSIONS'); for (const [d,n] of Object.entries(dims))        row(Si(`${d}-dim`), Gr(`${n} records`)); boxEnd(); }
  if (Object.keys(namespaces).length) { box('NAMESPACES'); for (const [ns,n] of Object.entries(namespaces)) row(Si(ns),        Gr(`${n} records`)); boxEnd(); }
  if (Object.keys(stores).length)     { box('SOURCES');    for (const [s,n] of Object.entries(stores))      row(Si(s),         Gr(`${n} records`)); boxEnd(); }
}

// ── VALIDATE ───────────────────────────────────────────────────────────────
async function cmdValidate(file) {
  if (!file || !fs.existsSync(file)) {
    console.error('\n' + R(`  ✗  File not found: ${file || '(none provided)'}`)); process.exit(1);
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
      console.log('  ' + BAR + '  ' + R(`✗  [${i}] id=${records[i].id ?? '?'}`));
      for (const e of errs) console.log('  ' + BAR + '     ' + Gr(`→ ${e}`));
    }
    if (!records[i].vector && records[i].text) {
      warnings++;
      console.log('  ' + BAR + '  ' + Y(`⚠  [${i}] no vector — re-embeddable from text`));
    }
  }

  if (!errors && !warnings)
    console.log('  ' + BAR + '  ' + G(`✓  All ${records.length} records valid`));

  boxEnd();
  box('RESULT');
  row(Si('records'),  W(String(records.length)));
  row(Si('errors'),   errors   ? R(String(errors))   : G('0'));
  row(Si('warnings'), warnings ? Y(String(warnings)) : G('0'));
  row(Si('status'),   errors   ? R('✗  INVALID')     : G('✓  VALID'));
  boxEnd();

  if (errors) process.exit(1);
}

// ── ADAPTERS (vec2vec) ─────────────────────────────────────────────────────
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
          row(Ic(src), Gr('→  ') + Sk(tgt));
        }
      }
    }
  } catch (e) {
    console.log('  ' + BAR + '  ' + R(e.message));
    console.log('  ' + BAR + '  ' + Gr('Install with: npm install @vektormemory/vex-adapter'));
  }
  boxEnd();
}

// ── SIGN ───────────────────────────────────────────────────────────────────
async function cmdSign(file, flags) {
  if (!file || !fs.existsSync(file)) {
    console.error(R(`\n  ✗  File not found: ${file || '(none provided)'}`)); process.exit(1);
  }
  banner();
  console.log('  ' + G('→') + '  Signing ' + Gr(file) + '\n');
  try {
    const sig = await signExport(file, {
      keyFile: flags.key || null,
      saveKey: true,
    });
    console.log('\n  ' + G('✓') + '  ' + W(String(sig.record_count)) + ' records signed');
    console.log('  ' + G('✓') + '  Signature → ' + Gr(file.replace(/\.vmig\.jsonl$/, '.vmig.sig')) + '\n');
  } catch (err) {
    if (err.message.includes('@noble')) {
      console.error('\n' + Y('  ⚠  Signing requires @noble packages:'));
      console.error(Y('     npm install @noble/hashes @noble/ed25519') + '\n');
    } else {
      console.error('\n' + R(`  ✗  ${err.message}`));
    }
    process.exit(1);
  }
}

// ── VERIFY ─────────────────────────────────────────────────────────────────
async function cmdVerify(file, flags) {
  if (!file || !fs.existsSync(file)) {
    console.error(R(`\n  ✗  File not found: ${file || '(none provided)'}`)); process.exit(1);
  }
  banner();
  console.log('  ' + G('→') + '  Verifying ' + Gr(file) + '\n');
  try {
    const result = await verifyExport(file, { sigFile: flags.sig || null });
    if (result.valid) {
      console.log('\n  ' + G('✓') + '  ' + W('Signature valid') + ' — file has not been tampered with\n');
      process.exit(0);
    } else {
      console.log('\n  ' + R('✗  Verification FAILED'));
      for (const e of result.errors) console.log('  ' + R('   → ') + Gr(e));
      console.log('');
      process.exit(1);
    }
  } catch (err) {
    if (err.message.includes('@noble')) {
      console.error('\n' + Y('  ⚠  Verification requires @noble packages:'));
      console.error(Y('     npm install @noble/hashes @noble/ed25519') + '\n');
    } else {
      console.error('\n' + R(`  ✗  ${err.message}`));
    }
    process.exit(1);
  }
}

// ── EXPORT ─────────────────────────────────────────────────────────────────
async function cmdExport(flags) {
  if (!flags.from)   { console.error(R('\n  ✗  --from required'));   process.exit(1); }
  if (!flags.output && !flags.o) { console.error(R('\n  ✗  --output required')); process.exit(1); }

  const outPath   = flags.output || flags.o;
  const connector = getConnector(flags.from);

  // ── --components filter (PAM five-component selective disclosure) ────────
  if (flags.components) {
    const allowed = new Set(
      String(flags.components).toLowerCase().split(',').map(s => s.trim()).filter(Boolean)
    );
    const VALID_TYPES = new Set(['episodic', 'semantic', 'procedural', 'working', 'identity']);
    for (const t of allowed) {
      if (!VALID_TYPES.has(t)) {
        console.error(R(`\n  ✗  Unknown component type: "${t}"`));
        console.error(Gr('     Valid types: episodic, semantic, procedural, working, identity'));
        process.exit(1);
      }
    }
    flags._componentFilter = allowed;
    console.log('  ' + G('→') + '  Component filter: ' + Ic([...allowed].join(', ')));
  }

  banner();
  const nsLabel    = flags.namespace  ? Gr(` [ns: ${flags.namespace}]`)         : '';
  const limLabel   = flags.limit      ? Gr(` [limit: ${flags.limit}]`)           : '';
  const compLabel  = flags.components ? Y(`  [components: ${flags.components}]`) : '';
  const chunkLabel = flags['chunk-mode'] ? Gr(` [chunk: ${flags['chunk-mode']}]`) : '';
  console.log('  ' + G('→') + '  Exporting from ' + Ic(flags.from) + nsLabel + limLabel + compLabel + chunkLabel + '\n');

  let total = await streamExport(connector, flags, outPath);

  // ── Post-export component filter ─────────────────────────────────────────
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
    console.log(`  ${G('→')}  Component filter applied: ${total} records kept`);
  }

  await writeMeta(outPath, {
    source_store: flags.from,
    exported_at:  new Date().toISOString(),
    components:   flags.components || null,
  });

  console.log('\n  ' + G('✓') + '  ' + W(String(total)) + ' records exported → ' + Gr(outPath) + '\n');

  // ── Auto-sign ─────────────────────────────────────────────────────────────
  if (flags.sign) {
    console.log('  ' + G('→') + '  Auto-signing...\n');
    try {
      await signExport(outPath, { keyFile: flags.key || null, saveKey: true });
      console.log('  ' + G('✓') + '  Signed → ' + Gr(outPath.replace(/\.vmig\.jsonl$/, '.vmig.sig')) + '\n');
    } catch (err) {
      console.warn(Y(`  ⚠  Sign failed (install @noble/hashes @noble/ed25519): ${err.message}`));
    }
  }
}

// ── IMPORT ─────────────────────────────────────────────────────────────────
async function cmdImport(flags) {
  if (!flags.from) { console.error(R('\n  ✗  --from required')); process.exit(1); }
  if (!flags.to)   { console.error(R('\n  ✗  --to required'));   process.exit(1); }
  if (!fs.existsSync(flags.from)) {
    console.error(R(`\n  ✗  File not found: ${flags.from}`)); process.exit(1);
  }

  const connector = getConnector(flags.to);

  banner();
  const adapterLabel = flags.adapter ? G('  [vec2vec adapter]') : flags.reembed ? Y('  [reembed]') : '';
  console.log('  ' + G('→') + '  ' + Gr(flags.from) + ' → ' + Ic(flags.to) + adapterLabel + '\n');

  const { total, upserted, skipped } = await streamImport(flags.from, connector, flags);

  writeMeta(flags.from, {
    imported_to: flags.to,
    imported_at: new Date().toISOString(),
  });

  console.log('\n  ' + G('✓') + '  ' + W(String(upserted)) + ' upserted' +
    (skipped ? '  ' + Y(`${skipped} skipped`) : '') + '\n');
}

// ── MIGRATE ────────────────────────────────────────────────────────────────
async function cmdMigrate(flags) {
  if (!flags.from) { console.error(R('\n  ✗  --from required')); process.exit(1); }
  if (!flags.to)   { console.error(R('\n  ✗  --to required'));   process.exit(1); }

  const fromConnector = getConnector(flags.from);
  const toConnector   = getConnector(flags.to);

  banner();
  const adapterLabel = flags.adapter ? G('  [vec2vec adapter]') : flags.reembed ? Y('  [reembed]') : '';
  const chunkLabel   = flags['chunk-mode'] ? Gr(`  [chunk: ${flags['chunk-mode']}]`) : '';
  console.log('  ' + G('→') + '  Migrating ' + Ic(flags.from) + ' → ' + Ic(flags.to) + adapterLabel + chunkLabel + '\n');

  const { total, upserted } = await coreMigrate(fromConnector, toConnector, flags);

  const _skStr = skipped > 0 ? ' (' + skipped + ' duplicate/skipped)' : '';
  console.log('\n  ' + G('✓') + '  ' + W(String(upserted)) + ' new records written' + _skStr + ' / ' + String(total) + ' total\n');
}

// ── CONVERT ────────────────────────────────────────────────────────────────
async function cmdConvert(flags) {
  if (!flags.adapter) { console.error(R('\n  ✗  --adapter required (try --adapter list)')); process.exit(1); }

  // ── list mode — no --from or --output needed ──────────────────────────────
  if (flags.adapter === 'list') {
    banner();
    box('CONVERT ADAPTERS');
    const adapters = listConvertAdapters();
    for (const a of adapters) {
      const nameCol = W(a.name.padEnd(22));
      const extCol  = Ic(`.${a.ext}  `);
      const descCol = Gr(a.description.length > 58 ? a.description.slice(0, 55) + '…' : a.description);
      row(nameCol, extCol + descCol);
    }
    blank();
    console.log('  ' + BAR + '  ' + Gr('Aliases: perplexity / groq / mistral / together → generic-chat'));
    console.log('  ' + BAR + '  ' + Gr('         anthropic → anthropic-finetune  |  txt → plain-text'));
    boxEnd();
    return;
  }

  if (!flags.from)               { console.error(R('\n  ✗  --from required'));    process.exit(1); }
  if (!flags.output && !flags.o) { console.error(R('\n  ✗  --output required')); process.exit(1); }

  if (!fs.existsSync(flags.from)) {
    console.error(R(`\n  ✗  File not found: ${flags.from}`)); process.exit(1);
  }

  let adapter;
  try {
    adapter = getConvertAdapter(flags.adapter);
  } catch (e) {
    console.error(R(`\n  ✗  ${e.message}`));
    console.log('  Run ' + Sk('vex convert --adapter list') + ' to see available adapters.\n');
    process.exit(1);
  }

  banner();
  console.log('  ' + G('→') + '  Converting ' + Gr(flags.from) + ' → ' + Ic(adapter.name) + '\n');

  const records = await readJsonl(flags.from);
  if (!records.length) {
    console.error(Y('\n  ⚠  Input file is empty')); process.exit(1);
  }

  box('CONVERT');
  row(Si('records'),    W(String(records.length)));
  row(Si('adapter'),    Ic(adapter.name));
  row(Si('output ext'), Gr('.' + adapter.fileExtension));
  if (flags['system-prompt']) row(Si('system prompt'), Gr(flags['system-prompt'].slice(0, 50) + (flags['system-prompt'].length > 50 ? '…' : '')));
  if (flags['chunk-mode'])    row(Si('chunk mode'),    Gr(flags['chunk-mode']));
  boxEnd();

  const output = adapter.convert(records, flags);

  // Auto-append extension if outPath has none
  const outPath   = flags.output || flags.o;
  const finalPath = outPath.includes('.') ? outPath : `${outPath}.${adapter.fileExtension}`;

  fs.writeFileSync(finalPath, output, 'utf8');

  const lineCount = output.trim().split('\n').filter(Boolean).length;
  console.log('  ' + G('✓') + '  ' + W(String(lineCount)) + ' lines written → ' + Gr(finalPath) + '\n');
}

// ── INTERACTIVE MENU ───────────────────────────────────────────────────────
async function interactiveMenu() {
  banner();
  console.log('  ' + W('No command given.') + Gr('  Run ') + Sk('vex --help') + Gr(' for full docs.\n'));

  const opts = [
    ['1', 'export',   'Export memory → .vmig.jsonl'],
    ['2', 'import',   'Import .vmig.jsonl → any store'],
    ['3', 'migrate',  'Migrate directly between stores'],
    ['4', 'convert',  'Convert .vmig.jsonl → LLM provider format'],
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
  rl.question('  ' + Sk('→') + '  ', answer => {
    rl.close();
    const map = {
      '1':'export','2':'import','3':'migrate','4':'convert',
      '5':'sign','6':'verify','7':'inspect','8':'validate','9':'adapters',
    };
    const ch = answer.trim().toLowerCase();
    console.log('');
    if (ch === 'h') { showHelp(); return; }
    if (ch === 'q' || !ch) process.exit(0);
    if (map[ch]) console.log('  ' + G('✓') + '  Run: ' + Sk(`vex ${map[ch]} --help`) + '\n');
    else         console.log('  ' + R('✗') + '  Unknown option.\n');
  });
}

// ── FLAG PARSER ────────────────────────────────────────────────────────────
function parseFlags(argv) {
  const flags = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key  = argv[i].slice(2);
      const next = argv[i + 1];
      flags[key] = (!next || next.startsWith('--')) ? true : next;
      if (next && !next.startsWith('--')) i++;
    }
  }
  return flags;
}

// ── MAIN ───────────────────────────────────────────────────────────────────
const args  = process.argv.slice(2);
const cmd   = args[0];
const flags = parseFlags(args);

try {
  if (!cmd)                                      { await interactiveMenu();                                         }
  else if (['--help','-h','help'].includes(cmd)) { showHelp();                                                      }
  else if (['--version','-v'].includes(cmd))     { console.log(`vex v${VERSION}`);                                  }
  else if (cmd === 'sign')                       { await cmdSign(args[1] || flags.file || flags.from, flags);       }
  else if (cmd === 'verify')                     { await cmdVerify(args[1] || flags.file || flags.from, flags);     }
  else if (cmd === 'inspect')                    { await cmdInspect(args[1] || flags.file || flags.from);           }
  else if (cmd === 'validate')                   { await cmdValidate(args[1] || flags.file || flags.from);          }
  else if (cmd === 'adapters')                   { await cmdAdapters();                                             }
  else if (cmd === 'export')                     { await cmdExport(flags);                                          }
  else if (cmd === 'import')                     { await cmdImport(flags);                                          }
  else if (cmd === 'migrate')                    { await cmdMigrate(flags);                                         }
  else if (cmd === 'convert')                    { await cmdConvert(flags);                                         }
  else {
    console.error(R(`\n  ✗  Unknown command: ${cmd}`));
    console.log('  Run ' + Sk('vex --help') + ' to see available commands.\n');
    process.exit(1);
  }
} catch (err) {
  console.error('\n' + R(`  ✗  ${err.message}`));
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
}
