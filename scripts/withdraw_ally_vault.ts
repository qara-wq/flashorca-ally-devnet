/*
 * Ally Vault Withdraw Helper (devnet friendly)
 *
 * 기능:
 *   - withdraw authority가 ally vault에 있는 FORCA를 treasury ATA로 인출 (withdraw_forca)
 *
 * 특징:
 *   - devnet.env 기본 로드
 *   - keypair는 파일/JSON/base58 모두 허용
 *   - dry-run 지원 (트랜잭션 전송 생략)
 *
 * 사용 예시:
 *   ts-node --transpile-only scripts/withdraw_ally_vault.ts \
 *     --ally 8b1sr6ZyBY68DvwZmfTBVu4b9Lyi9PthB9LU3PH2PBhF \
 *     --amount 1000000 \
 *     --authority ~/.config/solana/devnet.json \
 *     --dry-run
 */

import * as fs from 'fs';
import * as path from 'path';
import * as anchor from '@coral-xyz/anchor';
import { BN, Program } from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

import rewardVaultIdl from '../target/idl/reward_vault.json';
import { RewardVault } from '../target/types/reward_vault';

type CliOptions = {
  envPath?: string;
  allyMint?: string;
  amount?: string;
  authority?: string;
  programId?: string;
  rpcUrl?: string;
  dryRun?: boolean;
};

type IdlAccountType = {
  kind: 'struct';
  fields: Array<{ name: string; type: any }>;
};

const PRIMITIVE_SIZES: Record<string, number> = {
  bool: 1,
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  f32: 4,
  u64: 8,
  i64: 8,
  f64: 8,
  u128: 16,
  i128: 16,
  bytes: 1,
  pubkey: 32,
};

function printHelp() {
  console.log(`Ally Vault Withdraw Helper

Usage:
  ts-node --transpile-only scripts/withdraw_ally_vault.ts --ally <ALLY_NFT_MINT> --amount <FORCA_E6> [options]

Options:
  --env <path>        Load env file (default ../devnet.env)
  --ally <pubkey>     Ally NFT mint address
  --amount <u64>      Amount of FORCA (6 decimals) to withdraw
  --authority <src>   Withdraw authority keypair (path / JSON / base58)
  --program <id>      Override program id
  --rpc <url>         RPC endpoint
  --dry-run           Print plan without sending transaction
  --help              Show this help

Env fallbacks:
  RPC_URL, PROGRAM_ID, ALLY_NFT_MINT, ALLY_WITHDRAW_KEYPAIR, ALLY_SETTLE_KEYPAIR,
  POOL_AUTH_KEYPAIR, ADMIN_KEYPAIR
`);
}

function parseArgs(): CliOptions {
  const opts: CliOptions = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const raw = args[i];
    const [flag, valueFromEq] = raw.includes('=') ? raw.split('=', 2) : [raw, undefined];
    const readNext = () => { if (i + 1 >= args.length) throw new Error(`Missing value for ${flag}`); i += 1; return args[i]; };
    switch (flag) {
      case '--help':
      case '-h':
        printHelp(); process.exit(0);
      case '--env': opts.envPath = valueFromEq ?? readNext(); break;
      case '--ally': opts.allyMint = valueFromEq ?? readNext(); break;
      case '--amount': opts.amount = valueFromEq ?? readNext(); break;
      case '--authority': opts.authority = valueFromEq ?? readNext(); break;
      case '--program': opts.programId = valueFromEq ?? readNext(); break;
      case '--rpc': opts.rpcUrl = valueFromEq ?? readNext(); break;
      case '--dry-run': opts.dryRun = true; break;
      default:
        console.warn(`Unrecognized argument ignored: ${flag}`);
    }
  }
  return opts;
}

function expandHome(p: string) { if (!p) return p; return p.startsWith('~') ? path.join(process.env.HOME || '', p.slice(1)) : p; }
function unquote(v: string) { if (!v) return v; if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1); return v; }

function loadEnvFile(filePath: string): boolean {
  if (!filePath) return false;
  const expanded = expandHome(filePath);
  if (!fs.existsSync(expanded)) return false;
  const lines = fs.readFileSync(expanded, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = unquote(trimmed.slice(eq + 1).trim());
  }
  return true;
}

function keypairFromString(raw: string): Keypair {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Empty keypair input');
  if (trimmed.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
  if (trimmed.startsWith('{')) {
    const obj = JSON.parse(trimmed) as any;
    if (Array.isArray(obj)) return Keypair.fromSecretKey(Uint8Array.from(obj));
    if (Array.isArray(obj.secretKey)) return Keypair.fromSecretKey(Uint8Array.from(obj.secretKey));
    throw new Error('Unsupported JSON keypair format');
  }
  try {
    const decoded = bs58.decode(trimmed);
    return Keypair.fromSecretKey(decoded);
  } catch {
    // fallthrough to file path
  }
  const expanded = expandHome(trimmed);
  const rawFile = fs.readFileSync(expanded, 'utf8');
  const maybeJson = JSON.parse(rawFile);
  const arr = Array.isArray(maybeJson) ? maybeJson : maybeJson.secretKey;
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

function loadKeypair(source: string): Keypair {
  const expanded = expandHome(source);
  if (fs.existsSync(expanded)) {
    const raw = fs.readFileSync(expanded, 'utf8');
    return keypairFromString(raw);
  }
  return keypairFromString(source);
}

function parseU64(input?: string): bigint {
  if (!input) throw new Error('Amount is required (--amount)');
  const cleaned = input.replace(/[_\s]/g, '');
  if (!/^\d+$/.test(cleaned)) throw new Error(`Invalid amount "${input}"`);
  const v = BigInt(cleaned);
  if (v <= 0n) throw new Error('Amount must be > 0');
  if (v > 18446744073709551615n) throw new Error('Amount exceeds u64');
  return v;
}

function calculateTypeSize(
  typeRef: any,
  typeMap: Map<string, IdlAccountType>,
  seen: Set<string> = new Set(),
): number {
  if (typeof typeRef === 'string') {
    const size = PRIMITIVE_SIZES[typeRef];
    if (size === undefined) throw new Error(`Unsupported primitive: ${typeRef}`);
    return size;
  }
  if (typeRef === null || typeRef === undefined) throw new Error('Null/undefined type in IDL');
  if ('array' in typeRef) {
    const [inner, len] = typeRef.array;
    return calculateTypeSize(inner, typeMap, seen) * Number(len);
  }
  if ('option' in typeRef) return 1 + calculateTypeSize(typeRef.option, typeMap, seen);
  if ('defined' in typeRef) {
    const name = typeRef.defined;
    if (seen.has(name)) throw new Error(`Recursive type: ${name}`);
    const def = typeMap.get(name);
    if (!def) throw new Error(`Missing type definition for "${name}"`);
    seen.add(name);
    const size = calculateTypeSize(def, typeMap, seen);
    seen.delete(name);
    return size;
  }
  if ('kind' in typeRef && typeRef.kind === 'struct') {
    return typeRef.fields.reduce(
      (sum: number, field: { name: string; type: any }) => sum + calculateTypeSize(field.type, typeMap, seen),
      0,
    );
  }
  if ('kind' in typeRef && typeRef.kind === 'enum') return 1;
  throw new Error(`Unhandled IDL type: ${JSON.stringify(typeRef)}`);
}

function enrichIdlAccounts(rawIdl: any, requiredAccounts: string[]): any {
  const idl = JSON.parse(JSON.stringify(rawIdl));
  const typeMap = new Map<string, IdlAccountType>();
  for (const entry of idl.types ?? []) {
    if (entry?.type?.kind === 'struct') typeMap.set(entry.name, entry.type as IdlAccountType);
  }
  const required = new Set(requiredAccounts);
  const accounts: any[] = [];
  for (const acc of idl.accounts ?? []) {
    if (!required.has(acc.name)) continue;
    const struct = typeMap.get(acc.name);
    if (!struct) throw new Error(`IDL missing struct for account "${acc.name}"`);
    const dataSize = calculateTypeSize(struct, typeMap);
    accounts.push({ ...acc, type: struct, size: dataSize + 8 });
  }
  idl.accounts = accounts;
  return idl;
}

function formatAmount(value: bigint, decimals = 6) {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  return `${negative ? '-' : ''}${whole}.${frac.toString().padStart(decimals, '0')} FORCA`;
}

async function main() {
  const args = parseArgs();
  const envPath = args.envPath || process.env.ENV_PATH || path.resolve(__dirname, '../devnet.env');
  loadEnvFile(envPath) && console.log(`[env] Loaded ${envPath}`);

  const rpcUrl = args.rpcUrl || process.env.RPC_URL || 'https://api.devnet.solana.com';
  const allyMintRaw = args.allyMint || process.env.ALLY_NFT_MINT || (() => { throw new Error('Missing --ally'); })();
  const programIdRaw =
    args.programId ||
    process.env.PROGRAM_ID ||
    ((typeof rewardVaultIdl === 'object' && rewardVaultIdl && 'address' in rewardVaultIdl) ? (rewardVaultIdl as any).address : undefined);
  if (!programIdRaw) throw new Error('Program ID missing. Use --program or set PROGRAM_ID.');

  const amount = parseU64(args.amount || process.env.AMOUNT_FORCA);

  const authoritySrc =
    args.authority ||
    process.env.ALLY_WITHDRAW_KEYPAIR ||
    process.env.ALLY_SETTLE_KEYPAIR ||
    process.env.POOL_AUTH_KEYPAIR ||
    process.env.ADMIN_KEYPAIR ||
    (() => { throw new Error('Missing withdraw authority. Use --authority or set ALLY_WITHDRAW_KEYPAIR.'); })();

  const programId = new PublicKey(programIdRaw);
  const allyMint = new PublicKey(allyMintRaw);
  const withdrawKp = loadKeypair(authoritySrc);
  const dryRun = Boolean(args.dryRun || process.env.DRY_RUN === '1');

  console.log('=== Ally Vault Withdraw ===');
  console.log(`RPC endpoint      : ${rpcUrl}`);
  console.log(`Program ID        : ${programId.toBase58()}`);
  console.log(`Ally NFT mint     : ${allyMint.toBase58()}`);
  console.log(`Withdraw signer   : ${withdrawKp.publicKey.toBase58()}`);
  console.log(`Amount (FORCA e6) : ${amount.toString()} (${formatAmount(amount)})`);
  if (dryRun) console.log('[dry-run] Transaction will not be sent');

  console.log('\n[1] Preparing provider & program');
  const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
  } as any);
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(withdrawKp), {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  anchor.setProvider(provider);

  const patchedIdl = enrichIdlAccounts(rewardVaultIdl, ['VaultState', 'AllyAccount']);
  patchedIdl.address = programId.toBase58();
  const program = new Program<RewardVault>(patchedIdl as RewardVault, provider);

  const [vaultStatePda] = PublicKey.findProgramAddressSync([Buffer.from('vault_state')], programId);
  const [allyPda] = PublicKey.findProgramAddressSync([Buffer.from('ally'), allyMint.toBuffer()], programId);
  const [vaultSignerPda] = PublicKey.findProgramAddressSync([Buffer.from('vault_signer')], programId);

  console.log('[2] Fetch on-chain accounts');
  const vaultState = await program.account.vaultState.fetch(vaultStatePda);
  const ally = await program.account.allyAccount.fetchNullable(allyPda);
  if (!ally) throw new Error(`Ally account not found at ${allyPda.toBase58()}. register_ally를 먼저 실행하세요.`);

  console.log(`    vault_state    : ${vaultStatePda.toBase58()}`);
  console.log(`    ally           : ${allyPda.toBase58()}`);
  console.log(`    ops_auth       : ${ally.opsAuthority.toBase58()}`);
  console.log(`    withdraw_auth  : ${ally.withdrawAuthority.toBase58()}`);
  console.log(`    vault_ata      : ${ally.vaultAta.toBase58()}`);
  console.log(`    treasury_ata   : ${ally.treasuryAta.toBase58()}`);
  console.log(`    balance_forca  : ${ally.balanceForca.toString()} (${formatAmount(BigInt(ally.balanceForca))})`);
  console.log(`    rp_reserved    : ${ally.rpReserved.toString()} (${formatAmount(BigInt(ally.rpReserved))})`);

  if (!ally.withdrawAuthority.equals(withdrawKp.publicKey)) {
    console.warn('WARNING: withdraw authority mismatch with provided keypair');
  }
  if (!ally.vaultAta || !ally.treasuryAta) throw new Error('Ally vault/treasury ATA not set');
  if (BigInt(ally.balanceForca) < amount) throw new Error('Insufficient ally balance to withdraw requested amount');
  if (BigInt(ally.balanceForca - ally.rpReserved) < amount) {
    console.warn('WARNING: Withdrawal may violate reserved RP balance');
  }

  if (dryRun) {
    console.log('\n[dry-run] Ready to send withdraw_forca');
    return;
  }

  console.log('\n[3] Sending withdraw_forca transaction');
  try {
    const sig = await program.methods
      .withdrawForca(new BN(amount.toString()))
      .accountsStrict({
        withdrawAuthority: withdrawKp.publicKey,
        ally: allyPda,
        nftMint: allyMint,
        vaultState: vaultStatePda,
        vaultSigner: vaultSignerPda,
        allyVaultAta: ally.vaultAta,
        allyTreasuryAta: ally.treasuryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([withdrawKp])
      .rpc();
    console.log(`    tx signature   : ${sig}`);
    const confirmation = await connection.confirmTransaction(sig, 'confirmed');
    if (confirmation.value.err) {
      console.error('    Transaction error:', confirmation.value.err);
      throw new Error('withdraw_forca transaction failed');
    }
    console.log('    Status         : confirmed');
  } catch (err: any) {
    if (err instanceof SendTransactionError) {
      console.error('    Simulation failed:', err.message);
      try {
        const logs = await err.getLogs(connection);
        const lines = Array.isArray(logs)
          ? logs
          : (logs as { value?: { logs?: string[] } }).value?.logs;
        if (lines?.length) {
          console.error('    RPC logs:');
          for (const line of lines) console.error(`      ${line}`);
        }
      } catch (logErr) {
        console.error('    Unable to fetch logs:', (logErr as Error).message);
      }
    }
    throw err;
  }

  console.log('\n[4] Fetch updated ally account');
  const updated = await program.account.allyAccount.fetch(allyPda);
  console.log(`    balance_forca : ${updated.balanceForca.toString()} (${formatAmount(BigInt(updated.balanceForca))})`);
  console.log(`    rp_reserved   : ${updated.rpReserved.toString()} (${formatAmount(BigInt(updated.rpReserved))})`);
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
