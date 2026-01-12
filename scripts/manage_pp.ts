/*
 * Reward Vault PP Manager
 *
 * 기능:
 *   - 특정 Ally/사용자에 대한 PP 상태 조회 (query)
 *   - Ops authority가 사용자에게 PP 보너스를 지급 (grant)
 *   - Ops authority가 사용자 PP를 소모 처리 (consume)
 *
 * 사용 예시:
 *   ts-node scripts/manage_pp.ts --action query \
 *     --ally 8b1sr6ZyBY68DvwZmfTBVu4b9Lyi9PthB9LU3PH2PBhF \
 *     --user Gc53q3onKcDDkasuvXEog9Ucaa1RqraEvkTFGTiKsXMK
 *
 *   ts-node scripts/manage_pp.ts --action grant --amount 1500000 \
 *     --ally ... --user ... --authority ~/.config/solana/ally.json
 *
 * 옵션:
 *   --env <path>         .env 파일 경로 (기본: ../devnet.env)
 *   --action <mode>      query | grant | consume
 *   --ally <pubkey>      Ally NFT mint 주소
 *   --user <pubkey>      대상 사용자 주소
 *   --amount <u64>       grant/consume 시 필요한 PP 수량 (단위: 1e-6)
 *   --authority <src>    Ops authority 키페어 (파일/JSON/base58)
 *   --program <id>       프로그램 ID 재지정 (선택)
 *   --dry-run            grant/consume 시 트랜잭션 전송 없이 시뮬레이션
 *   --help               도움말 표시
 *
 * 환경변수 fallback:
 *   RPC_URL, PROGRAM_ID, ALLY_NFT_MINT, POP_USER, USER_PUBKEY,
 *   ALLY_OPS_KEYPAIR, ALLY_SETTLE_KEYPAIR, POOL_AUTH_KEYPAIR, ADMIN_KEYPAIR
 */

import * as fs from 'fs';
import * as path from 'path';
import * as anchor from '@coral-xyz/anchor';
import { Program, BN } from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  SystemProgram,
} from '@solana/web3.js';
import bs58 from 'bs58';

import rewardVaultIdl from '../target/idl/reward_vault.json';
import { RewardVault } from '../target/types/reward_vault';

type Action = 'query' | 'grant' | 'consume';

type CliOptions = {
  envPath?: string;
  action?: Action;
  allyMint?: string;
  user?: string;
  amount?: string;
  authority?: string;
  programId?: string;
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
  console.log(`Reward Vault PP Manager

Usage:
  ts-node scripts/manage_pp.ts --action <query|grant|consume> --ally <ALLY_NFT_MINT> --user <USER>
                               [--amount <PP_E6>] [--authority <KEYPAIR>] [options]

Options:
  --env <path>        Load environment variables from file (default ../devnet.env)
  --action <mode>     query | grant | consume
  --ally <pubkey>     Ally NFT mint address
  --user <pubkey>     Target user wallet
  --amount <u64>      PP amount in micro units (1e-6) for grant/consume
  --authority <src>   Ops authority keypair (path / JSON / base58)
  --program <id>      Override program id
  --dry-run           For grant/consume: skip submitting transaction
  --help              Show this help

Environment fallbacks:
  RPC_URL, PROGRAM_ID, ALLY_NFT_MINT, POP_USER, USER_PUBKEY,
  ALLY_OPS_KEYPAIR, ALLY_SETTLE_KEYPAIR, POOL_AUTH_KEYPAIR, ADMIN_KEYPAIR
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
      case '--action': {
        const val = (valueFromEq ?? readNext()).toLowerCase();
        if (val === 'query' || val === 'grant' || val === 'consume') {
          opts.action = val;
        } else {
          throw new Error(`Invalid action "${val}"`);
        }
        break;
      }
      case '--ally':
        opts.allyMint = valueFromEq ?? readNext();
        break;
      case '--user':
        opts.user = valueFromEq ?? readNext();
        break;
      case '--amount':
        opts.amount = valueFromEq ?? readNext();
        break;
      case '--authority':
        opts.authority = valueFromEq ?? readNext();
        break;
      case '--program':
        opts.programId = valueFromEq ?? readNext();
        break;
      case '--dry-run':
        opts.dryRun = true;
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

function keypairFromString(raw: string): Keypair {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Empty keypair input');
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  if (trimmed.startsWith('{')) {
    const obj = JSON.parse(trimmed);
    if (Array.isArray(obj)) {
      return Keypair.fromSecretKey(Uint8Array.from(obj));
    }
    if (Array.isArray(obj.secretKey)) {
      return Keypair.fromSecretKey(Uint8Array.from(obj.secretKey));
    }
    throw new Error('Unsupported JSON keypair format');
  }
  try {
    const decoded = bs58.decode(trimmed);
    return Keypair.fromSecretKey(decoded);
  } catch (e) {
    throw new Error('Failed to parse keypair from provided string/base58');
  }
}

function loadKeypair(source: string): Keypair {
  const expanded = expandHome(source);
  if (fs.existsSync(expanded)) {
    const raw = fs.readFileSync(expanded, 'utf8');
    return keypairFromString(raw);
  }
  return keypairFromString(source);
}

function parseU64(input: string): bigint {
  const cleaned = input.replace(/[_\s]/g, '');
  if (!/^\d+$/.test(cleaned)) throw new Error(`Invalid amount "${input}"`);
  const value = BigInt(cleaned);
  if (value < 0n || value > 18446744073709551615n) {
    throw new Error('Amount out of range for u64');
  }
  return value;
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
  const accounts: any[] = [];
  const required = new Set(requiredAccounts);
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

function formatAmount(value: bigint, decimals: number, unit: string) {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  return `${negative ? '-' : ''}${whole}.${frac.toString().padStart(decimals, '0')} ${unit}`;
}

function formatTimestamp(ts: number | BN | null | undefined) {
  if (ts === null || ts === undefined) return 'not set';
  let num: number;
  if (typeof ts === 'number') num = ts;
  else if (ts instanceof BN) num = ts.toNumber();
  else num = Number(ts);
  if (!Number.isFinite(num) || num === 0) return 'not set';
  return `${num} (${new Date(num * 1000).toISOString()})`;
}

async function main() {
  const args = parseArgs();

  const defaultEnv = args.envPath || process.env.ENV_PATH || path.resolve(__dirname, '../devnet.env');
  const envLoaded = loadEnvFile(defaultEnv);
  if (envLoaded) console.log(`[env] Loaded ${defaultEnv}`);

  const rpcUrl = process.env.RPC_URL || 'https://api.devnet.solana.com';
  const action: Action =
    args.action ||
    ((process.env.ACTION as Action) ?? undefined) ||
    (() => {
      throw new Error('Action not provided. Use --action query|grant|consume.');
    })();

  const allyMintRaw =
    args.allyMint ||
    process.env.ALLY_NFT_MINT ||
    (() => {
      throw new Error('Ally mint not provided. Use --ally.');
    })();
  const userRaw =
    args.user ||
    process.env.POP_USER ||
    process.env.USER_PUBKEY ||
    (() => {
      throw new Error('User public key not provided. Use --user.');
    })();

  const needsAmount = action === 'grant' || action === 'consume';
  const amountRaw = args.amount || process.env.AMOUNT_PP_E6;
  if (needsAmount && !amountRaw) {
    throw new Error('Amount is required for grant/consume actions.');
  }
  const amountU64 = needsAmount ? parseU64(amountRaw!) : 0n;

  const authoritySource =
    args.authority ||
    process.env.ALLY_OPS_KEYPAIR ||
    process.env.ALLY_SETTLE_KEYPAIR ||
    process.env.POOL_AUTH_KEYPAIR ||
    process.env.ADMIN_KEYPAIR ||
    (() => {
      throw new Error('Ops authority keypair not provided. Use --authority or set ALLY_OPS_KEYPAIR.');
    })();

  const programIdRaw =
    args.programId ||
    process.env.PROGRAM_ID ||
    (typeof rewardVaultIdl === 'object' && rewardVaultIdl && 'address' in rewardVaultIdl
      ? (rewardVaultIdl as any).address
      : undefined);
  if (!programIdRaw) throw new Error('Program ID missing. Use --program or set PROGRAM_ID.');

  const allyMint = new PublicKey(allyMintRaw);
  const userPubkey = new PublicKey(userRaw);
  const programId = new PublicKey(programIdRaw);
  const signer = loadKeypair(authoritySource);
  const dryRun = Boolean(args.dryRun || process.env.DRY_RUN === '1');

  console.log('=== Reward Vault :: PP Manager ===');
  console.log(`RPC endpoint      : ${rpcUrl}`);
  console.log(`Program ID        : ${programId.toBase58()}`);
  console.log(`Ops signer        : ${signer.publicKey.toBase58()}`);
  console.log(`Action            : ${action}`);
  console.log(`Ally NFT mint     : ${allyMint.toBase58()}`);
  console.log(`Target user       : ${userPubkey.toBase58()}`);
  if (needsAmount) {
    console.log(`Amount (PP e6)    : ${amountU64.toString()} (${formatAmount(amountU64, 6, 'PP')})`);
  }
  if (dryRun) console.log('[dry-run] Transaction will not be sent');

  console.log('\n[1] Preparing provider');
  const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
  } as any);
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(signer), {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  anchor.setProvider(provider);

  const patchedIdl = enrichIdlAccounts(rewardVaultIdl, ['VaultState', 'AllyAccount', 'UserLedger']);
  patchedIdl.address = programId.toBase58();
  const program = new Program<RewardVault>(patchedIdl as RewardVault, provider);

  const [vaultStatePda] = PublicKey.findProgramAddressSync([Buffer.from('vault_state')], programId);
  const [allyPda] = PublicKey.findProgramAddressSync([Buffer.from('ally'), allyMint.toBuffer()], programId);
  const [userLedgerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_ledger'), userPubkey.toBuffer(), allyMint.toBuffer()],
    programId,
  );

  console.log('[2] Fetching on-chain accounts');
  const vaultState = await program.account.vaultState.fetch(vaultStatePda);
  console.log(`    vault_state    : ${vaultStatePda.toBase58()}`);
  console.log(`    pop_admin     : ${vaultState.popAdmin.toBase58()}`);
  console.log(`    econ_admin     : ${vaultState.econAdmin.toBase58()}`);
  console.log(`    paused         : ${vaultState.paused ? 'yes' : 'no'}`);

  const allyAccount = await program.account.allyAccount.fetchNullable(allyPda);
  if (!allyAccount) {
    throw new Error(`Ally account not found at ${allyPda.toBase58()}. register_ally가 선행되어야 합니다.`);
  }
  console.log(`    ally account   : ${allyPda.toBase58()}`);
  console.log(`    ops auth       : ${allyAccount.opsAuthority.toBase58()}`);
  console.log(`    withdraw auth  : ${allyAccount.withdrawAuthority.toBase58()}`);
  console.log(`    rp_reserved    : ${allyAccount.rpReserved.toString()} (${formatAmount(BigInt(allyAccount.rpReserved), 6, 'FORCA')})`);
  console.log(`    balance_forca  : ${allyAccount.balanceForca.toString()} (${formatAmount(BigInt(allyAccount.balanceForca), 6, 'FORCA')})`);

  if (!allyAccount.opsAuthority.equals(signer.publicKey)) {
    console.warn('    WARNING: ops authority keypair does not match ally.ops_authority');
    if (action !== 'query' && !dryRun) {
      throw new Error('Signer mismatch. 정확한 ops authority 키를 --authority로 지정하세요.');
    }
  }

  const ledger = await program.account.userLedger.fetchNullable(userLedgerPda);
  if (ledger) {
    console.log(`    user_ledger    : ${userLedgerPda.toBase58()}`);
    console.log(`      rp_claimable : ${ledger.rpClaimableForca.toString()} (${formatAmount(BigInt(ledger.rpClaimableForca), 6, 'FORCA')})`);
    console.log(`      pp_balance   : ${ledger.ppBalance.toString()} (${formatAmount(BigInt(ledger.ppBalance), 6, 'PP')})`);
    console.log(`      hwm_claimed  : ${ledger.hwmClaimed.toString()}`);
    console.log(`      created_ts   : ${formatTimestamp(ledger.createdTs)}`);
    console.log(`      updated_ts   : ${formatTimestamp(ledger.updatedTs)}`);
  } else {
    console.log(`    user_ledger    : ${userLedgerPda.toBase58()} (not initialized)`);
    if (action === 'consume' && !dryRun) {
      throw new Error('User ledger가 존재하지 않아 consume 불가합니다. 먼저 convert/grant 등을 통해 생성하세요.');
    }
  }

  if (action === 'query' || dryRun) {
    console.log('\nNo transaction sent (query/dry-run).');
    return;
  }

  const amountBn = new BN(amountU64.toString());

  if (action === 'grant') {
    console.log('\n[3] Sending grant_bonus_pp transaction');
    try {
      const signature = await program.methods
      .grantBonusPp(amountBn)
      .accountsStrict({
        opsAuthority: signer.publicKey,
        ally: allyPda,
        vaultState: vaultStatePda,
        user: userPubkey,
        userLedger: userLedgerPda,
        systemProgram: SystemProgram.programId,
      })
        .rpc();
      console.log(`    tx signature   : ${signature}`);
      const confirmation = await connection.confirmTransaction(signature, 'confirmed');
      if (confirmation.value.err) {
        console.error('    Transaction error:', confirmation.value.err);
        throw new Error('grant_bonus_pp transaction failed');
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
  } else if (action === 'consume') {
    console.log('\n[3] Sending consume_pp transaction');
    if (!ledger) {
      throw new Error('consume_pp 실행 전 user ledger가 존재해야 합니다.');
    }
    try {
      const signature = await program.methods
      .consumePp(amountBn)
      .accountsStrict({
        opsAuthority: signer.publicKey,
        ally: allyPda,
        userLedger: userLedgerPda,
        vaultState: vaultStatePda,
      })
        .rpc();
      console.log(`    tx signature   : ${signature}`);
      const confirmation = await connection.confirmTransaction(signature, 'confirmed');
      if (confirmation.value.err) {
        console.error('    Transaction error:', confirmation.value.err);
        throw new Error('consume_pp transaction failed');
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
  } else {
    throw new Error(`Unhandled action ${action}`);
  }

  console.log('\n[4] Fetching updated user ledger');
  const updatedLedger = await program.account.userLedger.fetch(userLedgerPda);
  console.log(`    pp_balance   : ${updatedLedger.ppBalance.toString()} (${formatAmount(BigInt(updatedLedger.ppBalance), 6, 'PP')})`);
  console.log(`    updated_ts   : ${formatTimestamp(updatedLedger.updatedTs)}`);
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
