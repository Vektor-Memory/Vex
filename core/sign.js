/**
 * vex/core/sign.js
 * ─────────────────
 * BLAKE3 + Ed25519 signing for .vmig.jsonl exports.
 *
 * Usage:
 *   vex sign   memories.vmig.jsonl               → writes memories.vmig.sig
 *   vex verify memories.vmig.jsonl               → exits 0 (valid) or 1 (invalid)
 *   vex sign   memories.vmig.jsonl --key key.pem → use existing private key
 *
 * Sidecar format (.vmig.sig):
 *   {
 *     "vex_version": "0.4.0",
 *     "signed_at":   "2026-05-29T...",
 *     "record_count": 142,
 *     "root_hash":   "blake3:abc123...",   // BLAKE3 of canonical JSON of all record hashes
 *     "record_hashes": ["blake3:...", ...], // per-record BLAKE3 hashes
 *     "public_key":  "ed25519:base64...",  // verifier uses this
 *     "signature":   "base64..."           // Ed25519 sig of root_hash bytes
 *   }
 *
 * Verification:
 *   1. Recompute each record hash from the .vmig.jsonl file
 *   2. Recompute root hash from record hashes
 *   3. Verify Ed25519 signature of root hash using public_key in .vmig.sig
 *
 * Dependencies: @noble/hashes @noble/ed25519
 *   npm install @noble/hashes @noble/ed25519
 */

import fs   from 'fs';
import path from 'path';

// ── Dynamic loader — clear error if @noble packages missing ──────────────────

async function getNoble() {
  try {
    const { blake3 }  = await import('@noble/hashes/blake3');
    const ed          = await import('@noble/ed25519');
    return { blake3, ed };
  } catch {
    throw new Error(
      'Signing requires @noble/hashes and @noble/ed25519.\n' +
      '  Install: npm install @noble/hashes @noble/ed25519'
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toHex(buf) {
  return Buffer.from(buf).toString('hex');
}

function sigPath(vmigPath) {
  return vmigPath.replace(/\.vmig\.jsonl$/, '.vmig.sig');
}

function keyPath(vmigPath) {
  return vmigPath.replace(/\.vmig\.jsonl$/, '.vmig.key');
}

/**
 * Canonical JSON for a single .vmig record — consistent field order,
 * no whitespace, so the hash is deterministic regardless of insertion order.
 */
function canonicalRecord(r) {
  const keys = ['id', 'text', 'vector', 'model', 'dims', 'namespace',
                'agent_id', 'metadata', 'created_at', 'source_store', 'vex_version'];
  const obj = {};
  for (const k of keys) {
    if (r[k] !== undefined) obj[k] = r[k];
  }
  // include any extra keys not in the canonical list
  for (const k of Object.keys(r)) {
    if (!(k in obj)) obj[k] = r[k];
  }
  return JSON.stringify(obj);
}

/**
 * Read .vmig.jsonl and return raw line strings (not parsed) for hashing.
 * We hash the canonical form, not the raw line, to be whitespace-independent.
 */
function readLines(vmigFile) {
  return fs.readFileSync(vmigFile, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
}

/**
 * Parse and canonicalise each record, then compute BLAKE3 hashes.
 */
function hashRecords(lines, blake3) {
  return lines.map(line => {
    const rec = JSON.parse(line);
    const canonical = canonicalRecord(rec);
    const hash = blake3(new TextEncoder().encode(canonical));
    return 'blake3:' + toHex(hash);
  });
}

/**
 * Compute root hash: BLAKE3 of the JSON array of all record hashes.
 */
function rootHash(recordHashes, blake3) {
  const payload = JSON.stringify(recordHashes);
  const hash = blake3(new TextEncoder().encode(payload));
  return 'blake3:' + toHex(hash);
}

// ── SIGN ─────────────────────────────────────────────────────────────────────

/**
 * Sign a .vmig.jsonl file.
 * Writes <file>.vmig.sig alongside the export.
 * Optionally writes <file>.vmig.key (private key) on first run.
 *
 * @param {string} vmigFile  Path to .vmig.jsonl
 * @param {object} opts
 *   opts.keyFile  - path to existing private key file (hex or base64)
 *   opts.saveKey  - if true, save generated private key to .vmig.key (default: true)
 */
export async function signExport(vmigFile, opts = {}) {
  if (!fs.existsSync(vmigFile)) throw new Error(`File not found: ${vmigFile}`);

  const { blake3, ed } = await getNoble();

  // ── Key management ─────────────────────────────────────────────────────
  let privKeyBytes;
  const kPath = opts.keyFile || keyPath(vmigFile);

  if (opts.keyFile && fs.existsSync(opts.keyFile)) {
    // load provided key
    const raw = fs.readFileSync(opts.keyFile, 'utf8').trim();
    privKeyBytes = Buffer.from(raw.replace(/^(hex:|base64:)/, ''), raw.startsWith('base64:') ? 'base64' : 'hex');
    console.log(`[vex sign] using key: ${opts.keyFile}`);
  } else {
    // generate new key
    privKeyBytes = ed.utils.randomPrivateKey();
    const saveKey = opts.saveKey !== false;
    if (saveKey) {
      fs.writeFileSync(kPath, 'hex:' + toHex(privKeyBytes), 'utf8');
      console.log(`[vex sign] new private key saved → ${kPath}`);
      console.log(`[vex sign] ⚠  Keep this file safe — you need it to re-sign after edits`);
    }
  }

  const pubKeyBytes = await ed.getPublicKeyAsync(privKeyBytes);

  // ── Hash records ────────────────────────────────────────────────────────
  const lines   = readLines(vmigFile);
  console.log(`[vex sign] hashing ${lines.length} records...`);

  const recHashes = hashRecords(lines, blake3);
  const root      = rootHash(recHashes, blake3);

  // ── Sign root hash ──────────────────────────────────────────────────────
  const rootBytes = new TextEncoder().encode(root);
  const sigBytes  = await ed.signAsync(rootBytes, privKeyBytes);

  // ── Write .vmig.sig ─────────────────────────────────────────────────────
  const sigFile = sigPath(vmigFile);
  const sigObj  = {
    vex_version:    '0.4.0',
    signed_at:      new Date().toISOString(),
    record_count:   lines.length,
    root_hash:      root,
    record_hashes:  recHashes,
    public_key:     'ed25519:' + Buffer.from(pubKeyBytes).toString('base64'),
    signature:      Buffer.from(sigBytes).toString('base64'),
  };

  fs.writeFileSync(sigFile, JSON.stringify(sigObj, null, 2), 'utf8');

  console.log(`[vex sign] ✓ signed ${lines.length} records`);
  console.log(`[vex sign] root hash: ${root.slice(0, 32)}...`);
  console.log(`[vex sign] signature: → ${sigFile}`);
  return sigObj;
}

// ── VERIFY ────────────────────────────────────────────────────────────────────

/**
 * Verify a signed .vmig.jsonl file against its .vmig.sig sidecar.
 * Returns { valid: boolean, errors: string[] }
 *
 * @param {string} vmigFile  Path to .vmig.jsonl
 * @param {object} opts
 *   opts.sigFile - path to .vmig.sig (default: auto-detected)
 */
export async function verifyExport(vmigFile, opts = {}) {
  const errors = [];

  if (!fs.existsSync(vmigFile)) {
    return { valid: false, errors: [`File not found: ${vmigFile}`] };
  }

  const spath = opts.sigFile || sigPath(vmigFile);
  if (!fs.existsSync(spath)) {
    return { valid: false, errors: [`No signature file found: ${spath}`, 'Run vex sign first'] };
  }

  const { blake3, ed } = await getNoble();

  let sig;
  try {
    sig = JSON.parse(fs.readFileSync(spath, 'utf8'));
  } catch (e) {
    return { valid: false, errors: [`Cannot parse signature file: ${e.message}`] };
  }

  // ── Phase 1: record count ────────────────────────────────────────────────
  const lines = readLines(vmigFile);
  if (lines.length !== sig.record_count) {
    errors.push(`Record count mismatch: file has ${lines.length}, signature expects ${sig.record_count}`);
  }

  // ── Phase 2: recompute per-record hashes ─────────────────────────────────
  console.log(`[vex verify] hashing ${lines.length} records...`);
  const recHashes = hashRecords(lines, blake3);

  let hashMismatches = 0;
  for (let i = 0; i < Math.min(recHashes.length, (sig.record_hashes || []).length); i++) {
    if (recHashes[i] !== sig.record_hashes[i]) {
      hashMismatches++;
      if (hashMismatches <= 5) {
        errors.push(`Record ${i} hash mismatch (id: ${JSON.parse(lines[i])?.id ?? '?'})`);
      }
    }
  }
  if (hashMismatches > 5) errors.push(`...and ${hashMismatches - 5} more hash mismatches`);

  // ── Phase 3: recompute root hash ─────────────────────────────────────────
  const root = rootHash(recHashes, blake3);
  if (root !== sig.root_hash) {
    errors.push(`Root hash mismatch`);
    errors.push(`  computed: ${root}`);
    errors.push(`  in sig:   ${sig.root_hash}`);
  }

  // ── Phase 4: verify Ed25519 signature ─────────────────────────────────────
  try {
    const pubKeyRaw  = sig.public_key.replace(/^ed25519:/, '');
    const pubKeyBytes = Buffer.from(pubKeyRaw, 'base64');
    const sigBytes    = Buffer.from(sig.signature, 'base64');
    const rootBytes   = new TextEncoder().encode(sig.root_hash); // verify against stored root
    const valid       = await ed.verifyAsync(sigBytes, rootBytes, pubKeyBytes);
    if (!valid) errors.push('Ed25519 signature invalid — file may have been tampered with');
  } catch (e) {
    errors.push(`Ed25519 verification failed: ${e.message}`);
  }

  return { valid: errors.length === 0, errors };
}
