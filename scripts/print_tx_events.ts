/*
 Pretty-print Anchor events and raw logs for a Solana transaction.

 Usage examples:
   - ts-node scripts/print_tx_events.ts <TXID>
   - ts-node scripts/print_tx_events.ts <TXID> --idl target/idl/reward_vault.json
   - ts-node scripts/print_tx_events.ts <TXID> --program 2SBFs9cnkv6NZjM28a87ysPr7zvPWj7KuQC4WW16nGS7
   - RPC_URL=https://api.devnet.solana.com ts-node scripts/print_tx_events.ts <TXID>

 By default, this script tries to read env vars from ./devnet.env if present.
 RPC URL resolution priority: --rpc > RPC_URL > DEVNET_URL > https://api.devnet.solana.com
 Program ID resolution priority: --program > PROGRAM_ID > IDL.address (if IDL provided)
*/

import * as fs from 'fs';
import * as path from 'path';
import * as anchor from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';

type Idl = any;

function readEnvFile(p: string) {
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim();
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch (_) {
    // ignore if missing
  }
}

function parseArgs(argv: string[]) {
  const args = { _: [] as string[], flags: new Map<string, string | boolean>() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        args.flags.set(key, next);
        i++;
      } else {
        args.flags.set(key, true);
      }
    } else if (a.startsWith('-')) {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        args.flags.set(key, next);
        i++;
      } else {
        args.flags.set(key, true);
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function asString(v: unknown) {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  return String(v);
}

function hrTime(ts?: number | null) {
  if (!ts) return 'n/a';
  try { return new Date(ts * 1000).toISOString(); } catch { return String(ts); }
}

function isBN(x: any): boolean {
  return x && typeof x === 'object' && (x as any).toArray && (x as any).toString && (x as any).isZero !== undefined;
}

function isPubkey(x: any): x is PublicKey {
  return x && typeof x === 'object' && typeof (x as any).toBase58 === 'function';
}

function toPlain(obj: any): any {
  if (obj == null) return obj;
  if (Array.isArray(obj)) return obj.map(toPlain);
  if (isBN(obj)) {
    // Represent BN as string to avoid precision loss
    return (obj as any).toString(10);
  }
  if (isPubkey(obj)) return (obj as PublicKey).toBase58();
  if (typeof obj === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) out[k] = toPlain(v);
    return out;
  }
  return obj;
}

async function main() {
  // Try to preload ./devnet.env by default
  const defaultEnvPath = path.join(process.cwd(), 'devnet.env');
  readEnvFile(defaultEnvPath);

  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has('help') || args.flags.has('h') || args._.length === 0) {
    console.log('Usage: ts-node scripts/print_tx_events.ts <TXID> [--rpc <URL>] [--idl <PATH>] [--program <PUBKEY>] [--env <PATH>]');
    console.log('  --rpc      RPC URL (overrides env)');
    console.log('  --idl      Path to Anchor IDL JSON (default: target/idl/reward_vault.json)');
    console.log('  --program  Program ID to decode events for (default: PROGRAM_ID or IDL.address)');
    console.log('  --env      Env file path to load (default: devnet.env if present)');
    process.exit(0);
  }

  const txid = args._[0];
  const envPath = asString(args.flags.get('env') || '');
  if (envPath) readEnvFile(path.resolve(envPath));

  const rpcUrl = asString(
    args.flags.get('rpc') || process.env.RPC_URL || process.env.DEVNET_URL || 'https://api.devnet.solana.com'
  );

  // Load IDL if available
  let idlJson: Idl | null = null;
  const idlPath = asString(args.flags.get('idl') || process.env.IDL_PATH || 'target/idl/reward_vault.json');
  try {
    const raw = fs.readFileSync(path.resolve(idlPath), 'utf-8');
    idlJson = JSON.parse(raw);
  } catch (_) {
    // IDL optional; we can still show raw logs
  }

  // Resolve program id
  const programStr = asString(args.flags.get('program') || process.env.PROGRAM_ID || (idlJson && (idlJson.address || idlJson?.metadata?.address)) || '');
  const programId = programStr ? new PublicKey(programStr) : null;

  const connection = new Connection(rpcUrl, { commitment: 'confirmed' } as any);

  // Fetch transaction
  const tx = await connection.getTransaction(txid, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  } as any);

  if (!tx) {
    console.error('Transaction not found. Check the txid and RPC/cluster.');
    process.exit(1);
  }

  // Header
  const status = tx.meta?.err ? 'ERR' : 'OK';
  console.log('==== Transaction ====');
  console.log(`Signature : ${tx.transaction.signatures[0]}`);
  console.log(`Status    : ${status}`);
  console.log(`Slot      : ${tx.slot}`);
  console.log(`BlockTime : ${hrTime(tx.blockTime)}`);
  if (tx.meta?.err) console.log(`Error     : ${JSON.stringify(tx.meta.err)}`);

  // Raw logs
  const logs = tx.meta?.logMessages || [];
  console.log('');
  console.log('---- Raw Logs ----');
  if (logs.length === 0) {
    console.log('(no logs)');
  } else {
    for (const line of logs) console.log(line);
  }

  // Anchor event parsing (if IDL + programId available)
  if (idlJson && programId) {
    console.log('');
    console.log('---- Anchor Events ----');
    const coder = new anchor.BorshCoder(idlJson as any);
    const parser = new anchor.EventParser(programId, coder);
    let anyEvent = false;
    try {
      for (const evt of parser.parseLogs(logs)) {
        anyEvent = true;
        const plain = toPlain(evt.data);
        console.log(`Event: ${evt.name}`);
        console.log(JSON.stringify(plain, null, 2));
      }
    } catch (e) {
      console.log('(failed to parse anchor events)');
      console.log(String(e));
    }
    if (!anyEvent) console.log('(no anchor events decoded for this program)');
  } else {
    console.log('');
    console.log('---- Anchor Events ----');
    if (!idlJson) console.log('(skip) No IDL loaded. Provide --idl or target/idl/...');
    if (!programId) console.log('(skip) No program id resolved. Provide --program or PROGRAM_ID');
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});

