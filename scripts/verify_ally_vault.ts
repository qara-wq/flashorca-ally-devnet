/*
 * Reward Vault :: Ally Vault Verifier
 *
 * 기능:
 *   - Ally 상태(balance_forca, rp_reserved)와 실제 ally_vault_ata SPL 토큰 잔고를 비교하여 불일치 탐지
 *   - vault_ata의 mint/owner가 기대값(포르카 mint, vault_signer PDA)과 일치하는지 확인
 *
 * 사용 예시:
 *   ts-node --transpile-only scripts/verify_ally_vault.ts --ally <ALLY_NFT_MINT>
 *   ts-node --transpile-only scripts/verify_ally_vault.ts --all
 *
 * 주요 옵션:
 *   --env <path>      .env 파일 경로 (기본: ../devnet.env)
 *   --ally <pubkey>   특정 Ally NFT mint만 검사 (env ALLY_NFT_MINT fallback)
 *   --all             모든 AllyAccount를 순회 검사 (프로그램 account 조회)
 *   --program <id>    프로그램 ID (기본: env PROGRAM_ID 또는 IDL.address)
 *   --rpc <url>       RPC URL (기본: env RPC_URL 또는 devnet)
 *   --no-fail         불일치 발견 시에도 exit code 0으로 종료
 *   --help            도움말
 *
 * 환경변수 fallback:
 *   RPC_URL, PROGRAM_ID, ALLY_NFT_MINT, ENV_PATH
 */

import * as fs from 'fs';
import * as path from 'path';
import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAccount } from '@solana/spl-token';

import rewardVaultIdl from '../target/idl/reward_vault.json';
import { RewardVault } from '../target/types/reward_vault';

type CliOptions = {
  envPath?: string;
  allyMint?: string;
  all?: boolean;
  programId?: string;
  rpcUrl?: string;
  noFail?: boolean;
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
  console.log(`Reward Vault Ally Vault Verifier

Usage:
  ts-node --transpile-only scripts/verify_ally_vault.ts --ally <ALLY_NFT_MINT> [options]
  ts-node --transpile-only scripts/verify_ally_vault.ts --all [options]

Options:
  --env <path>      Load env file (default ../devnet.env)
  --ally <pubkey>   Verify specific Ally NFT mint (env ALLY_NFT_MINT fallback)
  --all             Verify all Ally accounts on-chain
  --program <id>    Override program id
  --rpc <url>       RPC endpoint (default env RPC_URL or devnet)
  --no-fail         Do not exit with non-zero on mismatch
  --help            Show this help

Environment fallbacks:
  RPC_URL, PROGRAM_ID, ALLY_NFT_MINT, ENV_PATH
`);
}

function parseArgs(): CliOptions {
  const opts: CliOptions = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const raw = args[i];
    const [flag, valueFromEq] = raw.includes('=') ? raw.split('=', 2) : [raw, undefined];
    const readNext = () => {
      if (i + 1 >= args.length) throw new Error(`Missing value for ${flag}`);
      i += 1;
      return args[i];
    };
    switch (flag) {
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      case '--env':
        opts.envPath = valueFromEq ?? readNext();
        break;
      case '--ally':
        opts.allyMint = valueFromEq ?? readNext();
        break;
      case '--all':
        opts.all = true;
        break;
      case '--program':
        opts.programId = valueFromEq ?? readNext();
        break;
      case '--rpc':
        opts.rpcUrl = valueFromEq ?? readNext();
        break;
      case '--no-fail':
        opts.noFail = true;
        break;
      default:
        console.warn(`Unrecognized argument ignored: ${flag}`);
        break;
    }
  }
  return opts;
}

function expandHome(p: string) {
  if (!p) return p;
  if (p.startsWith('~')) return path.join(process.env.HOME || '', p.slice(1));
  return p;
}

function unquote(value: string) {
  if (!value) return value;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function loadEnvFile(filePath: string): boolean {
  if (!filePath) return false;
  const expanded = expandHome(filePath);
  if (!fs.existsSync(expanded)) return false;
  const content = fs.readFileSync(expanded, 'utf8');
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    const rawVal = trimmed.slice(eq + 1).trim();
    process.env[key] = unquote(rawVal);
  }
  return true;
}

function calculateTypeSize(
  typeRef: any,
  typeMap: Map<string, IdlAccountType>,
  seen: Set<string> = new Set(),
): number {
  if (typeof typeRef === 'string') {
    const size = PRIMITIVE_SIZES[typeRef];
    if (size === undefined) {
      throw new Error(`Unsupported primitive type in IDL: ${typeRef}`);
    }
    return size;
  }
  if (typeRef === null || typeRef === undefined) {
    throw new Error('Encountered null/undefined type in IDL');
  }
  if ('array' in typeRef) {
    const [inner, len] = typeRef.array;
    return calculateTypeSize(inner, typeMap, seen) * Number(len);
  }
  if ('option' in typeRef) {
    return 1 + calculateTypeSize(typeRef.option, typeMap, seen);
  }
  if ('defined' in typeRef) {
    const name = typeRef.defined;
    if (seen.has(name)) {
      throw new Error(`Recursive type detected in IDL: ${name}`);
    }
    const def = typeMap.get(name);
    if (!def) {
      throw new Error(`Missing type definition for "${name}" in IDL`);
    }
    seen.add(name);
    const size = calculateTypeSize(def, typeMap, seen);
    seen.delete(name);
    return size;
  }
  if ('kind' in typeRef && typeRef.kind === 'struct') {
    return typeRef.fields.reduce(
      (sum: number, field: { name: string; type: any }) =>
        sum + calculateTypeSize(field.type, typeMap, seen),
      0,
    );
  }
  if ('kind' in typeRef && typeRef.kind === 'enum') {
    return 1;
  }
  throw new Error(`Unhandled IDL type form: ${JSON.stringify(typeRef)}`);
}

function enrichIdlAccounts(rawIdl: any, requiredAccounts: string[]): any {
  const idl = JSON.parse(JSON.stringify(rawIdl));
  const typeMap = new Map<string, IdlAccountType>();
  for (const entry of idl.types ?? []) {
    if (entry?.type?.kind === 'struct') {
      typeMap.set(entry.name, entry.type as IdlAccountType);
    }
  }
  const required = new Set(requiredAccounts);
  const accounts: any[] = [];
  for (const acc of idl.accounts ?? []) {
    if (!required.has(acc.name)) continue;
    const struct = typeMap.get(acc.name);
    if (!struct) {
      throw new Error(`IDL missing struct definition for account "${acc.name}"`);
    }
    const dataSize = calculateTypeSize(struct, typeMap);
    accounts.push({
      ...acc,
      type: struct,
      size: dataSize + 8,
    });
  }
  idl.accounts = accounts;
  return idl;
}

function formatLamports(value: bigint, decimals = 6) {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  return `${negative ? '-' : ''}${whole}.${frac.toString().padStart(decimals, '0')}`;
}

async function main() {
  const args = parseArgs();

  const defaultEnv = args.envPath || process.env.ENV_PATH || path.resolve(__dirname, '../devnet.env');
  const envLoaded = loadEnvFile(defaultEnv);
  if (envLoaded) console.log(`[env] Loaded ${defaultEnv}`);

  const rpcUrl = args.rpcUrl || process.env.RPC_URL || 'https://api.devnet.solana.com';
  const programIdRaw =
    args.programId ||
    process.env.PROGRAM_ID ||
    (typeof rewardVaultIdl === 'object' && rewardVaultIdl && 'address' in rewardVaultIdl
      ? (rewardVaultIdl as any).address
      : undefined);
  if (!programIdRaw) throw new Error('Program ID missing. Use --program or set PROGRAM_ID.');
  const programId = new PublicKey(programIdRaw);

  const verifyAll = Boolean(args.all);
  const allyMintRaw = args.allyMint || process.env.ALLY_NFT_MINT;
  if (!verifyAll && !allyMintRaw) {
    throw new Error('Ally mint not provided. Use --ally <MINT> or --all.');
  }

  console.log('=== Reward Vault :: Ally Vault Verifier ===');
  console.log(`RPC endpoint : ${rpcUrl}`);
  console.log(`Program ID   : ${programId.toBase58()}`);
  if (allyMintRaw) console.log(`Target ally : ${allyMintRaw}${verifyAll ? ' (specific filter while scanning all)' : ''}`);
  if (verifyAll) console.log('Mode        : scan all ally accounts');

  const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
  } as any);
  const dummy = Keypair.generate();
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(dummy), {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  anchor.setProvider(provider);

  const patchedIdl = enrichIdlAccounts(rewardVaultIdl, ['VaultState', 'AllyAccount']);
  patchedIdl.address = programId.toBase58();
  const program = new Program<RewardVault>(patchedIdl as RewardVault, provider);

  const [vaultStatePda] = PublicKey.findProgramAddressSync([Buffer.from('vault_state')], programId);
  const [vaultSigner] = PublicKey.findProgramAddressSync([Buffer.from('vault_signer')], programId);

  console.log('\n[1] Fetching vault_state');
  const vaultState = await program.account.vaultState.fetch(vaultStatePda);
  console.log(`    vault_state : ${vaultStatePda.toBase58()}`);
  console.log(`    forca_mint  : ${vaultState.forcaMint.toBase58()}`);
  console.log(`    paused      : ${vaultState.paused ? 'yes' : 'no'}`);

  console.log('\n[2] Collecting Ally accounts');
  const targets: Array<{ allyMint: PublicKey; allyPda: PublicKey; account: any }> = [];
  if (verifyAll) {
    const all = await program.account.allyAccount.all();
    for (const entry of all) {
      const allyMint = entry.account.nftMint as PublicKey;
      if (allyMintRaw && allyMint.toBase58() !== allyMintRaw) continue;
      targets.push({
        allyMint,
        allyPda: entry.publicKey,
        account: entry.account,
      });
    }
  } else {
    const allyMintPk = new PublicKey(allyMintRaw!);
    const [allyPda] = PublicKey.findProgramAddressSync([Buffer.from('ally'), allyMintPk.toBuffer()], programId);
    const allyAccount = await program.account.allyAccount.fetchNullable(allyPda);
    if (!allyAccount) {
      throw new Error(`Ally account not found at ${allyPda.toBase58()}.`);
    }
    targets.push({ allyMint: allyMintPk, allyPda, account: allyAccount });
  }

  if (targets.length === 0) {
    console.log('No ally accounts matched the criteria.');
    return;
  }

  let mismatchCount = 0;
  let checked = 0;

  console.log('\n[3] Verifying ally vault balances');
  for (const target of targets) {
    checked += 1;
    const ally = target.account;
    const vaultAta = ally.vaultAta as PublicKey;
    const rpReserved = BigInt(ally.rpReserved.toString());
    const stateBalance = BigInt(ally.balanceForca.toString());

    console.log(`\n- Ally NFT mint : ${target.allyMint.toBase58()}`);
    console.log(`  Ally account  : ${target.allyPda.toBase58()}`);
    console.log(`  vault_ata     : ${vaultAta.toBase58()}`);
    console.log(`  rp_reserved   : ${rpReserved.toString()} (${formatLamports(rpReserved)} FORCA)`);
    console.log(`  state balance : ${stateBalance.toString()} (${formatLamports(stateBalance)} FORCA)`);

    const warnings: string[] = [];

    try {
      const ata = await getAccount(connection, vaultAta, 'confirmed', TOKEN_PROGRAM_ID);
      const onChain = ata.amount;
      const diff = onChain - stateBalance;
      const unreservedState = stateBalance - rpReserved;
      const unreservedOnChain = onChain - rpReserved;

      console.log(`  token amount  : ${onChain.toString()} (${formatLamports(onChain)} FORCA)`);
      console.log(`  diff (token-state) : ${diff.toString()} (${formatLamports(diff)} FORCA)`);
      console.log(`  unreserved (state/token) : ${formatLamports(unreservedState)} / ${formatLamports(unreservedOnChain)} FORCA`);

      if (!ata.mint.equals(vaultState.forcaMint)) {
        warnings.push(`mint mismatch: vault_ata mint ${ata.mint.toBase58()} != forca_mint ${vaultState.forcaMint.toBase58()}`);
      }
      if (!ata.owner.equals(vaultSigner)) {
        warnings.push(`owner mismatch: vault_ata owner ${ata.owner.toBase58()} != vault_signer ${vaultSigner.toBase58()}`);
      }
      if (diff !== 0n) {
        warnings.push('balance_forca differs from on-chain token amount');
      }
      if (onChain < rpReserved) {
        warnings.push('on-chain amount is below rp_reserved (reserved funds not fully covered)');
      }
    } catch (err) {
      warnings.push(`failed to read vault_ata: ${(err as Error).message}`);
    }

    if (warnings.length > 0) {
      mismatchCount += 1;
      for (const w of warnings) {
        console.warn(`  [warn] ${w}`);
      }
    } else {
      console.log('  Status        : OK');
    }
  }

  console.log('\n[4] Summary');
  console.log(`  Checked allies : ${checked}`);
  console.log(`  Mismatches     : ${mismatchCount}`);

  if (mismatchCount > 0 && !args.noFail) {
    console.error('Mismatch detected. Exit code 1 (use --no-fail to override).');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
