#!/usr/bin/env node
import { getConnector }                          from './connectors/index.js';
import { writeMeta, readJsonl, validate }        from './formats/vmig.js';
import { streamExport, streamImport, migrate as coreMigrate } from './core/migrate.js';
import { listAdapters }                          from './utils/adapt.js';
import { signExport, verifyExport }              from './core/sign.js';
import { getAdapter as getConvertAdapter, listConvertAdapters } from './adapters/convert/index.js';
import { runPipeline }                          from './pipeline/index.js';
import { cmdSync }                               from './core/sync-cmd.js';

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

const VERSION = '0.8.6';

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
  row(W('sync'),     Sk('vex sync')      + Gr('  init | push | pull | status | diff'));
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
  row(Sk('--limit'),         Gr('<n>      max records to export'));
  row(Sk('--output'),        Gr('<file>   destination .vmig.jsonl'));
  row(Sk('--db'),            Gr('<path>   VEKTOR SQLite DB path'));
  row(Sk('--dry-run'),       Y('preview') + Gr('  Show what would happen without writing'));
  boxEnd();

  box('EXAMPLES');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Export VEKTOR memory'));
  console.log('  ' + BAR + '  ' + Sk('vex export') + ' --from vektor --db memory.db --output memories.vmig.jsonl');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Migrate Claude conversations to VEKTOR'));
  console.log('  ' + BAR + '  ' + Sk('vex migrate') + ' --from claude-export --to vektor --file conversations.json --db memory.db');
  blank();
  console.log('  ' + BAR + '  ' + Gr('# Convert to OpenAI fine-tune format'));
  console.log('  ' + BAR + '  ' + Sk('vex convert') + ' --from memories.vmig.jsonl --adapter openai-finetune --output training.jsonl');
  blank();
  boxEnd();
}

// ── Ink TUI ──────────────────────────────────────────────────────────────────
async function launchTUI() {
  const ink                      = await import('ink');
  const { render, Box, Text, useApp, useInput } = ink;
  const { default: SelectInput } = await import('ink-select-input');
  const { default: TextInput }   = await import('ink-text-input');
  const React                    = await import('react');
  const { useState }             = React;
  const h = React.createElement;

  const COMMANDS = {
    export:   'Export memory to .vmig.jsonl',
    import:   'Import .vmig.jsonl to any vector store',
    migrate:  'Migrate directly between two stores',
    convert:  'Convert .vmig.jsonl to LLM provider format',
    sync:     'Sync memory across stores',
    sign:     'Sign export with BLAKE3 + Ed25519',
    verify:   'Verify a signed .vmig.jsonl file',
    inspect:  'Show stats, models and namespaces in a file',
    validate: 'Lint and validate all records in a file',
    adapters: 'List available vec2vec projection pairs',
  };

  const Header = ({ cmd }) => h(Box, { flexDirection:'column', paddingLeft:2, paddingBottom:1 },
    h(Text, { color:'cyan', bold:true }, 'vex ' + cmd),
    h(Text, { color:'gray', dimColor:true }, COMMANDS[cmd] || '')
  );

  const Footer = () => h(Text, { color:'gray', dimColor:true, marginLeft:2 }, 'esc to go back');

  const Ask = ({ prompt, placeholder, hint, onSubmit, onBack }) => {
    const [val, setVal] = useState('');
    useInput((_, key) => { if (key.escape) onBack(); });
    return h(Box, { flexDirection:'column', paddingLeft:2 },
      h(Text, { color:'cyan' }, prompt),
      hint && h(Text, { color:'gray', dimColor:true }, hint),
      h(Box, { marginTop:1 },
        h(Text, { color:'cyan' }, '> '),
        h(TextInput, { value:val, placeholder, onChange:setVal,
          onSubmit: v => { if(v.trim()) onSubmit(v.trim()); }
        })
      ),
      h(Text, { color:'gray', dimColor:true }, 'enter to confirm   esc to go back')
    );
  };

  const STORES = [
    { label:'vektor         VEKTOR Slipstream SQLite', value:'vektor' },
    { label:'claude-export  Claude conversations',     value:'claude-export' },
    { label:'chatgpt-export ChatGPT conversations',    value:'chatgpt-export' },
    { label:'pinecone       Pinecone',                 value:'pinecone' },
    { label:'qdrant         Qdrant',                   value:'qdrant' },
    { label:'chroma         ChromaDB',                 value:'chroma' },
    { label:'weaviate       Weaviate',                 value:'weaviate' },
    { label:'pgvector       PostgreSQL pgvector',      value:'pgvector' },
    { label:'redis          Redis Stack',              value:'redis' },
    { label:'milvus         Milvus / Zilliz',          value:'milvus' },
    { label:'neo4j          Neo4j',                    value:'neo4j' },
  ];

  const WIZARDS = {

    export: ({ onRun, onBack }) => {
      const [step, setStep]       = useState('store');
      const [fromStore, setFrom]  = useState('');
      const [dbPath, setDb]       = useState('');
      useInput((_, key) => { if (key.escape) step === 'store' ? onBack() : setStep('store'); });

      if (step === 'store') return h(Box, { flexDirection:'column' },
        h(Header, { cmd:'export' }),
        h(Text, { color:'cyan', marginLeft:2, marginBottom:1 }, 'Export FROM which store?'),
        h(SelectInput, { items: STORES, onSelect: item => {
          setFrom(item.value);
          setStep(item.value === 'vektor' ? 'db' : 'output');
        }}),
        h(Footer, null)
      );
      if (step === 'db') return h(Box, { flexDirection:'column' },
        h(Header, { cmd:'export' }),
        h(Ask, { prompt:'Path to VEKTOR SQLite DB?',
          placeholder:'e.g. memory.db  or  ~/.vektor/slipstream-memory.db',
          hint:'tip: leave blank to use VEKTOR_DB_PATH env var',
          onSubmit: v => { setDb(v); setStep('output'); },
          onBack: () => setStep('store') })
      );
      return h(Box, { flexDirection:'column' },
        h(Header, { cmd:'export' }),
        h(Ask, { prompt:'Output .vmig.jsonl file path?',
          placeholder:'e.g. ./memories.vmig.jsonl',
          onSubmit: v => {
            const a = ['--from', fromStore, '--output', v];
            if (dbPath) a.push('--db', dbPath);
            onRun(a);
          },
          onBack: () => setStep(fromStore === 'vektor' ? 'db' : 'store') })
      );
    },

    import: ({ onRun, onBack }) => {
      const [step, setStep] = useState('file');
      const [file, setFile] = useState('');
      useInput((_, key) => { if (key.escape) step === 'file' ? onBack() : setStep('file'); });

      if (step === 'file') return h(Box, { flexDirection:'column' },
        h(Header, { cmd:'import' }),
        h(Ask, { prompt:'Path to .vmig.jsonl file to import?',
          placeholder:'./memories.vmig.jsonl',
          onSubmit: v => { setFile(v); setStep('store'); }, onBack })
      );
      return h(Box, { flexDirection:'column' },
        h(Header, { cmd:'import' }),
        h(Text, { color:'gray', marginLeft:2, marginBottom:1 }, 'file: "' + file + '"'),
        h(Text, { color:'cyan', marginLeft:2 }, 'Import TO which store?'),
        h(Box, { marginTop:1 },
          h(SelectInput, { items: STORES.filter(s => !s.value.includes('export')),
            onSelect: item => onRun(['--from', file, '--to', item.value])
          })
        ),
        h(Footer, null)
      );
    },

    migrate: ({ onRun, onBack }) => {
      const [step, setStep]      = useState('from');
      const [fromStore, setFrom] = useState('');
      useInput((_, key) => { if (key.escape) step === 'from' ? onBack() : setStep('from'); });

      if (step === 'from') return h(Box, { flexDirection:'column' },
        h(Header, { cmd:'migrate' }),
        h(Text, { color:'cyan', marginLeft:2, marginBottom:1 }, 'Migrate FROM?'),
        h(SelectInput, { items: STORES, onSelect: item => { setFrom(item.value); setStep('to'); }}),
        h(Footer, null)
      );
      return h(Box, { flexDirection:'column' },
        h(Header, { cmd:'migrate' }),
        h(Text, { color:'gray', marginLeft:2, marginBottom:1 }, 'from: ' + fromStore),
        h(Text, { color:'cyan', marginLeft:2 }, 'Migrate TO?'),
        h(Box, { marginTop:1 },
          h(SelectInput, { items: STORES.filter(s => s.value !== fromStore && !s.value.includes('export')),
            onSelect: item => onRun(['--from', fromStore, '--to', item.value])
          })
        ),
        h(Footer, null)
      );
    },

    convert: ({ onRun, onBack }) => {
      const [step, setStep] = useState('file');
      const [file, setFile] = useState('');
      useInput((_, key) => { if (key.escape) step === 'file' ? onBack() : setStep('file'); });

      const ADAPTERS = [
        { label:'openai-finetune     OpenAI fine-tuning JSONL',       value:'openai-finetune' },
        { label:'openai-context      OpenAI chat messages JSON',       value:'openai-context' },
        { label:'generic-chat        Groq / Mistral / Together JSONL', value:'generic-chat' },
        { label:'anthropic-finetune  Anthropic Messages format',       value:'anthropic-finetune' },
        { label:'plain-text          Human-readable .txt transcript',  value:'plain-text' },
      ];

      if (step === 'file') return h(Box, { flexDirection:'column' },
        h(Header, { cmd:'convert' }),
        h(Ask, { prompt:'Path to .vmig.jsonl to convert?',
          placeholder:'./memories.vmig.jsonl',
          onSubmit: v => { setFile(v); setStep('adapter'); }, onBack })
      );
      return h(Box, { flexDirection:'column' },
        h(Header, { cmd:'convert' }),
        h(Text, { color:'gray', marginLeft:2, marginBottom:1 }, 'file: "' + file + '"'),
        h(Text, { color:'cyan', marginLeft:2 }, 'Convert to which format?'),
        h(Box, { marginTop:1 },
          h(SelectInput, { items: ADAPTERS,
            onSelect: item => onRun(['--from', file, '--adapter', item.value])
          })
        ),
        h(Footer, null)
      );
    },

    sync: ({ onRun, onBack }) => {
      useInput((_, key) => { if (key.escape) onBack(); });
      return h(Box, { flexDirection:'column' },
        h(Header, { cmd:'sync' }),
        h(Text, { color:'cyan', marginLeft:2, marginBottom:1 }, 'What do you want to do?'),
        h(SelectInput, { items:[
          { label:'init    set up sync config',       value:['init'] },
          { label:'push    push local to remote',     value:['push'] },
          { label:'pull    pull remote to local',     value:['pull'] },
          { label:'status  show sync status',         value:['status'] },
          { label:'diff    show diff between stores', value:['diff'] },
        ], onSelect: item => onRun(item.value) }),
        h(Footer, null)
      );
    },

    sign: ({ onRun, onBack }) => {
      useInput((_, key) => { if (key.escape) onBack(); });
      return h(Box, { flexDirection:'column' },
        h(Header, { cmd:'sign' }),
        h(Ask, { prompt:'Path to .vmig.jsonl to sign?',
          placeholder:'./memories.vmig.jsonl',
          hint:'generates .vmig.sig and .vmig.key alongside the file',
          onSubmit: v => onRun([v]), onBack })
      );
    },

    verify: ({ onRun, onBack }) => {
      useInput((_, key) => { if (key.escape) onBack(); });
      return h(Box, { flexDirection:'column' },
        h(Header, { cmd:'verify' }),
        h(Ask, { prompt:'Path to .vmig.jsonl to verify?',
          placeholder:'./memories.vmig.jsonl',
          hint:'exits 0=valid  1=tampered',
          onSubmit: v => onRun([v]), onBack })
      );
    },

    inspect: ({ onRun, onBack }) => {
      useInput((_, key) => { if (key.escape) onBack(); });
      return h(Box, { flexDirection:'column' },
        h(Header, { cmd:'inspect' }),
        h(Ask, { prompt:'Path to .vmig.jsonl to inspect?',
          placeholder:'./memories.vmig.jsonl',
          hint:'shows records, models, dimensions, namespaces',
          onSubmit: v => onRun([v]), onBack })
      );
    },

    validate: ({ onRun, onBack }) => {
      useInput((_, key) => { if (key.escape) onBack(); });
      return h(Box, { flexDirection:'column' },
        h(Header, { cmd:'validate' }),
        h(Ask, { prompt:'Path to .vmig.jsonl to validate?',
          placeholder:'./memories.vmig.jsonl',
          hint:'lints all records, reports errors and warnings',
          onSubmit: v => onRun([v]), onBack })
      );
    },

    adapters: ({ onRun, onBack }) => {
      useInput((_, key) => { if (key.escape) onBack(); });
      return h(Box, { flexDirection:'column' },
        h(Header, { cmd:'adapters' }),
        h(Text, { color:'gray', marginLeft:2 }, 'Lists all vec2vec projection pairs — no input needed.'),
        h(Box, { marginTop:1 },
          h(SelectInput, { items:[
            { label:'Show all adapters', value:[] },
            { label:'Back to menu',      value:'back' },
          ], onSelect: item => item.value === 'back' ? onBack() : onRun([]) })
        )
      );
    },
  };

  const VexApp = () => {
    const { exit }            = useApp();
    const [screen, setScreen] = useState('palette');
    const [cmd, setCmd]       = useState(null);
    useInput(input => { if (input === 'q' && screen === 'palette') exit(); });

    const items = Object.entries(COMMANDS).map(([k, v]) => ({
      label: k.padEnd(12) + ' ' + v, value: k
    }));

    const runCmd = async (selectedCmd, args) => {
      exit();
      await new Promise(r => setTimeout(r, 80));
      const { default: child } = await import('child_process');
      child.spawnSync(process.execPath, [process.argv[1], selectedCmd, ...args],
        { stdio:'inherit', shell: process.platform === 'win32' });
    };

    if (screen === 'palette') return h(Box, { flexDirection:'column', paddingTop:1 },
      h(Text, { color:'gray', dimColor:true, marginLeft:2 }, 'up/down  enter=select  q=quit'),
      h(Box, { marginTop:1 },
        h(SelectInput, { items,
          onSelect: item => { setCmd(item.value); setScreen('wizard'); }
        })
      )
    );

    if (screen === 'wizard' && cmd && WIZARDS[cmd]) {
      const Wizard = WIZARDS[cmd];
      return h(Wizard, {
        onRun:  (args) => { setScreen('done'); runCmd(cmd, args); },
        onBack: () => setScreen('palette'),
      });
    }
    return h(Box, { padding:1 }, h(Text, { color:'cyan' }, '  running vex ' + cmd + '...'));
  };

  banner();
  render(h(VexApp, null));
}

// ── Existing command functions (unchanged) ───────────────────────────────────

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
    if (r.model)        models[r.model]         = (models[r.model]        || 0) + 1;
    if (r.dims)         dims[String(r.dims)]    = (dims[String(r.dims)]   || 0) + 1;
    if (r.namespace)    namespaces[r.namespace]  = (namespaces[r.namespace]|| 0) + 1;
    if (r.source_store) stores[r.source_store]   = (stores[r.source_store] || 0) + 1;
  }
  const metaPath = file.replace(/\.vmig\.jsonl$/, '.vmig.meta.json');
  let meta = null;
  if (fs.existsSync(metaPath)) try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
  box('FILE SUMMARY');
  row(Si('records'),     W(String(records.length)));
  row(Si('with vector'), G(String(records.length - nullVec))  + (nullVec  ? '  ' + Y(`(${nullVec} null)`)  : ''));
  row(Si('with text'),   G(String(records.length - nullText)) + (nullText ? '  ' + Y(`(${nullText} null)`) : ''));
  if (dates.length) { row(Si('earliest'), Gr(dates[0])); row(Si('latest'), Gr(dates[dates.length - 1])); }
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
  if (!errors && !warnings) console.log('  ' + BAR + '  ' + G('\u2713  All records valid'));
  boxEnd();
  if (errors)   console.log('  ' + R(`${errors} error(s)`));
  if (warnings) console.log('  ' + Y(`${warnings} warning(s)`));
  if (errors) process.exit(1);
}

async function cmdAdapters() {
  banner();
  const pairs = await listAdapters();
  box('VEC2VEC PROJECTION PAIRS');
  for (const p of pairs) row(Si(p.from + ' \u2192 ' + p.to), Gr(p.dims + 'd \u2192 ' + p.targetDims + 'd'));
  boxEnd();
}

async function cmdSign(file, flags) {
  if (!file) { console.error(R('\n  \u2717  Usage: vex sign <file>')); process.exit(1); }
  const result = await signExport(file, flags);
  banner();
  box('SIGN');
  row(Si('file'),      Sk(file));
  row(Si('signature'), G(result.sigFile));
  row(Si('key'),       Gr(result.keyFile));
  row(Si('hash'),      Ic(result.hash.slice(0, 32) + '...'));
  boxEnd();
}

async function cmdVerify(file, flags) {
  if (!file) { console.error(R('\n  \u2717  Usage: vex verify <file>')); process.exit(1); }
  const result = await verifyExport(file, flags);
  banner();
  box('VERIFY');
  row(Si('file'),   Sk(file));
  row(Si('status'), result.valid ? G('\u2713  VALID') : R('\u2717  TAMPERED'));
  if (result.reason) row(Si('reason'), Y(result.reason));
  boxEnd();
  if (!result.valid) process.exit(1);
}

async function cmdExport(flags) {
  const connector = await getConnector(flags.from, flags);
  const meta      = await streamExport(connector, flags);
  banner();
  box('EXPORT COMPLETE');
  row(Si('source'),  W(flags.from));
  row(Si('output'),  Sk(flags.output || meta.file));
  row(Si('records'), G(String(meta.count)));
  if (meta.namespaces?.length) row(Si('namespaces'), Gr(meta.namespaces.join(', ')));
  boxEnd();
}

async function cmdImport(flags) {
  const connector = await getConnector(flags.to, flags);
  const meta      = await streamImport(connector, flags);
  banner();
  box('IMPORT COMPLETE');
  row(Si('source'),    Sk(flags.from));
  row(Si('target'),    W(flags.to));
  row(Si('imported'),  G(String(meta.count)));
  if (meta.skipped) row(Si('skipped'), Y(String(meta.skipped)));
  boxEnd();
}

async function cmdMigrate(flags) {
  const src = await getConnector(flags.from, flags);
  const dst = await getConnector(flags.to,   flags);
  const meta = await coreMigrate(src, dst, flags);
  banner();
  box('MIGRATE COMPLETE');
  row(Si('from'),    W(flags.from));
  row(Si('to'),      W(flags.to));
  row(Si('records'), G(String(meta.count)));
  if (meta.skipped) row(Si('skipped'), Y(String(meta.skipped)));
  boxEnd();
}

async function cmdConvert(flags) {
  if (flags.adapter === 'list') { const list = listConvertAdapters(); banner(); box('ADAPTERS'); for (const a of list) row(Si(a.name), Gr(a.description)); boxEnd(); return; }
  if (!flags.from) { console.error(R('\n  \u2717  Usage: vex convert --from <file.vmig.jsonl> --adapter <name> [--output <file>]') + '\n'); process.exit(1); }
  const adapter = getConvertAdapter(flags.adapter);
  const records = await readJsonl(flags.from);
  const content = adapter.convert(records, flags);
  const outFile = flags.output ?? flags.from.replace(/\.vmig\.jsonl$/, '.' + adapter.fileExtension);
  fs.writeFileSync(outFile, content, 'utf8');
  banner();
  box('CONVERT COMPLETE');
  row(Si('adapter'), W(flags.adapter));
  row(Si('input'),   Sk(flags.from));
  row(Si('output'),  Sk(outFile));
  row(Si('records'), G(String(records.length)));
  boxEnd();
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
  if (!cmd && process.stdout.isTTY && !process.env.CI) { await launchTUI();                                                 }
  else if (!cmd)                                        { showHelp();                                                        }
  else if (['--help','-h','help'].includes(cmd))        { showHelp();                                                        }
  else if (['--version','-v'].includes(cmd))            { console.log(`vex v${VERSION}`);                                   }
  else if (cmd === 'sign')                              { await cmdSign(args[1] || flags.file || flags.from, flags);         }
  else if (cmd === 'verify')                            { await cmdVerify(args[1] || flags.file || flags.from, flags);       }
  else if (cmd === 'inspect')                           { await cmdInspect(args[1] || flags.file || flags.from);             }
  else if (cmd === 'validate')                          { await cmdValidate(args[1] || flags.file || flags.from);            }
  else if (cmd === 'adapters')                          { await cmdAdapters();                                               }
  else if (cmd === 'export')                            { await cmdExport(flags);                                            }
  else if (cmd === 'import')                            { await cmdImport(flags);                                            }
  else if (cmd === 'migrate')                           { await cmdMigrate(flags);                                           }
  else if (cmd === 'sync')                              { await cmdSync(args, flags);                                        }
  else if (cmd === 'convert')                           { await cmdConvert(flags);                                           }
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
