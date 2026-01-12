/*
 * Reward Vault Ally PoP Enforcement Manager
 *
 * Features:
 *   - Query PoP enforcement for an ally (query)
 *   - Toggle PoP enforcement using the withdraw authority (set)
 *
 * Examples:
 *   ts-node scripts/set_ally_pop_enforcement.ts --action query --ally <ALLY_NFT_MINT>
 *   ts-node scripts/set_ally_pop_enforcement.ts --action set --ally <ALLY_NFT_MINT> --enforce true --authority <WITHDRAW_KP>
 *
 * Options:
 *   --env <path>        .env file path (default: ../devnet.env)
 *   --action <mode>     query | set
 *   --ally <pubkey>     Ally NFT mint address
 *   --enforce <bool>    Required for set (true/false/1/0)
 *   --authority <src>   Withdraw authority keypair (path/JSON/base58)
 *   --program <id>      Override program id (optional)
 *   --rpc <url>         RPC URL (optional)
 *   --dry-run           Skip submitting tx for set
 *   --help              Show help
 *
 * Env fallbacks:
 *   RPC_URL, PROGRAM_ID, ALLY_NFT_MINT,
 *   ALLY_WITHDRAW_KEYPAIR, ALLY_SETTLE_KEYPAIR, ADMIN_KEYPAIR
 */

import * as fs from 'fs';
import * as path from 'path';
import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SendTransactionError } from '@solana/web3.js';
import bs58 from 'bs58';

import rewardVaultIdl from '../target/idl/reward_vault.json';
import { RewardVault } from '../target/types/reward_vault';

type Action = 'query' | 'set';

type CliOptions = {
  envPath?: string;
  action?: Action;
  allyMint?: string;
  enforce?: string;
  authority?: string;
  programId?: string;
  rpcUrl?: string;
  dryRun?: boolean;
};

function printHelp() {
  console.log(`Reward Vault Ally PoP Enforcement Manager

Usage:
  ts-node scripts/set_ally_pop_enforcement.ts --action <query|set> --ally <ALLY_NFT_MINT> [options]

Options:
  --env <path>        Load env file (default ../devnet.env)
  --action <mode>     query | set
  --ally <pubkey>     Ally NFT mint address
  --enforce <bool>    For set: true/false/1/0
  --authority <src>   Withdraw authority keypair (path / JSON / base58)
  --program <id>      Override program id
  --rpc <url>         RPC endpoint
  --dry-run           For set: skip submitting transaction
  --help              Show this help

Env fallbacks:
  RPC_URL, PROGRAM_ID, ALLY_NFT_MINT,
  ALLY_WITHDRAW_KEYPAIR, ALLY_SETTLE_KEYPAIR, ADMIN_KEYPAIR
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
        if (val === 'query' || val === 'set') {
          opts.action = val;
        } else {
          throw new Error(`Invalid action "${val}"`);
        }
        break;
      }
      case '--ally':
        opts.allyMint = valueFromEq ?? readNext();
        break;
      case '--enforce':
        opts.enforce = valueFromEq ?? readNext();
        break;
      case '--authority':
        opts.authority = valueFromEq ?? readNext();
        break;
      case '--program':
        opts.programId = valueFromEq ?? readNext();
        break;
      case '--rpc':
        opts.rpcUrl = valueFromEq ?? readNext();
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
  } catch {
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

function parseBool(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
  throw new Error(`Invalid boolean value "${raw}"`);
}

async function main() {
  const args = parseArgs();
  const envPath = args.envPath || process.env.ENV_PATH || path.resolve(__dirname, '../devnet.env');
  loadEnvFile(envPath) && console.log(`[env] Loaded ${envPath}`);

  const rpcUrl = args.rpcUrl || process.env.RPC_URL || 'https://api.devnet.solana.com';
  const action: Action =
    args.action ||
    ((process.env.ACTION as Action) ?? undefined) ||
    (() => { throw new Error('Action not provided. Use --action query|set.'); })();
  const allyMintRaw =
    args.allyMint || process.env.ALLY_NFT_MINT || (() => { throw new Error('Ally mint not provided. Use --ally.'); })();

  const programIdRaw =
    args.programId ||
    process.env.PROGRAM_ID ||
    (typeof rewardVaultIdl === 'object' && rewardVaultIdl && 'address' in rewardVaultIdl
      ? (rewardVaultIdl as any).address
      : undefined);
  if (!programIdRaw) throw new Error('Program ID missing. Use --program or set PROGRAM_ID.');

  const allyMint = new PublicKey(allyMintRaw);
  const programId = new PublicKey(programIdRaw);

  const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
  } as any);

  const idlJson: any = { ...(rewardVaultIdl as any), address: programId.toBase58() };
  const readProvider = new anchor.AnchorProvider(connection, new (anchor as any).Wallet(Keypair.generate()), {});
  let program = new Program(idlJson, readProvider) as Program<RewardVault>;

  const [allyPda] = PublicKey.findProgramAddressSync([Buffer.from('ally'), allyMint.toBuffer()], programId);
  const ally = await program.account.allyAccount.fetchNullable(allyPda);
  if (!ally) throw new Error(`Ally account not found at ${allyPda.toBase58()}. Run register_ally first.`);

  console.log('=== Ally PoP Enforcement ===');
  console.log(`RPC endpoint   : ${rpcUrl}`);
  console.log(`Program ID     : ${programId.toBase58()}`);
  console.log(`Ally NFT mint  : ${allyMint.toBase58()}`);
  console.log(`Ally PDA       : ${allyPda.toBase58()}`);
  console.log(`Ops auth       : ${ally.opsAuthority.toBase58()}`);
  console.log(`Withdraw auth  : ${ally.withdrawAuthority.toBase58()}`);
  console.log(`PoP enforced   : ${ally.popEnforced ? 'true' : 'false'}`);

  if (action === 'query') return;

  const enforceRaw = args.enforce ?? process.env.POP_ENFORCED;
  if (!enforceRaw) throw new Error('Missing --enforce for set action.');
  const enforce = parseBool(enforceRaw);

  const authoritySrc =
    args.authority ||
    process.env.ALLY_WITHDRAW_KEYPAIR ||
    process.env.ALLY_SETTLE_KEYPAIR ||
    process.env.ADMIN_KEYPAIR ||
    (() => { throw new Error('Withdraw authority keypair not provided. Use --authority or set ALLY_WITHDRAW_KEYPAIR.'); })();
  const withdrawKp = loadKeypair(authoritySrc);
  const dryRun = Boolean(args.dryRun || process.env.DRY_RUN === '1');

  console.log(`Withdraw signer: ${withdrawKp.publicKey.toBase58()}`);
  if (!ally.withdrawAuthority.equals(withdrawKp.publicKey)) {
    console.warn('WARNING: withdraw authority mismatch with provided keypair');
  }

  if (dryRun) {
    console.log(`[dry-run] set_ally_pop_enforcement = ${enforce}`);
    return;
  }

  const writeProvider = new anchor.AnchorProvider(connection, new anchor.Wallet(withdrawKp), {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  program = new Program(idlJson, writeProvider) as Program<RewardVault>;

  try {
    const sig = await program.methods
      .setAllyPopEnforcement(enforce)
      .accountsStrict({
        withdrawAuthority: withdrawKp.publicKey,
        ally: allyPda,
      })
      .signers([withdrawKp])
      .rpc();
    console.log(`tx signature  : ${sig}`);
  } catch (err: any) {
    if (err instanceof SendTransactionError) {
      console.error('Simulation failed:', err.message);
      try {
        const logs = await err.getLogs(connection as any);
        const lines = Array.isArray(logs)
          ? logs
          : (logs as { value?: { logs?: string[] } }).value?.logs;
        if (lines?.length) {
          console.error('RPC logs:');
          for (const line of lines) console.error(`  ${line}`);
        }
      } catch (_) {}
    }
    throw err;
  }

  const updated = await program.account.allyAccount.fetch(allyPda);
  console.log(`PoP enforced   : ${updated.popEnforced ? 'true' : 'false'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
