/*
 * Reward Vault Ally Authority Rotator
 *
 * Usage:
 *   ts-node scripts/set_ally_authorities.ts --type <ops|withdraw> --ally <ALLY_NFT_MINT> --new <PUBKEY>
 *
 * Options:
 *   --env <path>        .env file path (default: ../devnet.env)
 *   --type <role>       ops | withdraw
 *   --ally <pubkey>     Ally NFT mint address
 *   --new <pubkey>      New authority pubkey
 *   --authority <src>   Current authority keypair (ops or withdraw)
 *   --new-treasury <pk> (withdraw only) new treasury ATA (defaults to derived ATA)
 *   --program <id>      Override program id
 *   --rpc <url>         RPC URL (optional)
 *   --dry-run           Skip submitting tx
 *   --help              Show help
 *
 * Env fallbacks:
 *   RPC_URL, PROGRAM_ID, ALLY_NFT_MINT,
 *   ALLY_OPS_KEYPAIR, ALLY_WITHDRAW_KEYPAIR, ADMIN_KEYPAIR,
 *   NEW_AUTHORITY, NEW_TREASURY_ATA, AUTHORITY_TYPE
 */

import * as fs from 'fs';
import * as path from 'path';
import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SendTransactionError } from '@solana/web3.js';
import {
  getAccount,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';

import rewardVaultIdl from '../target/idl/reward_vault.json';
import { RewardVault } from '../target/types/reward_vault';

type AuthorityType = 'ops' | 'withdraw';

type CliOptions = {
  envPath?: string;
  authorityType?: AuthorityType;
  allyMint?: string;
  newAuthority?: string;
  authority?: string;
  newTreasuryAta?: string;
  programId?: string;
  rpcUrl?: string;
  dryRun?: boolean;
};

function printHelp() {
  console.log(`Reward Vault Ally Authority Rotator

Usage:
  ts-node scripts/set_ally_authorities.ts --type <ops|withdraw> --ally <ALLY_NFT_MINT> --new <PUBKEY> [options]

Options:
  --env <path>          Load env file (default ../devnet.env)
  --type <role>         ops | withdraw
  --ally <pubkey>       Ally NFT mint address
  --new <pubkey>        New authority pubkey
  --authority <src>     Current authority keypair (path / JSON / base58)
  --new-treasury <pk>   (withdraw only) new treasury ATA (defaults to derived ATA)
  --program <id>        Override program id
  --rpc <url>           RPC endpoint
  --dry-run             Skip submitting transaction
  --help                Show this help

Env fallbacks:
  RPC_URL, PROGRAM_ID, ALLY_NFT_MINT,
  ALLY_OPS_KEYPAIR, ALLY_WITHDRAW_KEYPAIR, ADMIN_KEYPAIR,
  NEW_AUTHORITY, NEW_TREASURY_ATA, AUTHORITY_TYPE
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
      case '--type': {
        const val = (valueFromEq ?? readNext()).toLowerCase();
        if (val === 'ops' || val === 'withdraw') opts.authorityType = val;
        else throw new Error(`Invalid type "${val}"`);
        break;
      }
      case '--ally':
        opts.allyMint = valueFromEq ?? readNext();
        break;
      case '--new':
        opts.newAuthority = valueFromEq ?? readNext();
        break;
      case '--authority':
        opts.authority = valueFromEq ?? readNext();
        break;
      case '--new-treasury':
        opts.newTreasuryAta = valueFromEq ?? readNext();
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
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
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
    if (Array.isArray(obj)) return Keypair.fromSecretKey(Uint8Array.from(obj));
    if (Array.isArray(obj.secretKey)) return Keypair.fromSecretKey(Uint8Array.from(obj.secretKey));
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

function parsePubkey(input: string): PublicKey {
  try {
    return new PublicKey(input.trim());
  } catch {
    throw new Error(`Invalid pubkey: ${input}`);
  }
}

async function main() {
  const args = parseArgs();

  const defaultEnv = args.envPath || process.env.ENV_PATH || path.resolve(__dirname, '../devnet.env');
  const envLoaded = loadEnvFile(defaultEnv);
  if (envLoaded) console.log(`[env] Loaded ${defaultEnv}`);

  const rpcUrl = args.rpcUrl || process.env.RPC_URL || 'https://api.devnet.solana.com';
  const authorityType = args.authorityType || (process.env.AUTHORITY_TYPE as AuthorityType | undefined);
  const allyMintRaw = args.allyMint || process.env.ALLY_NFT_MINT;
  const newAuthorityRaw = args.newAuthority || process.env.NEW_AUTHORITY;
  const programIdRaw = args.programId || process.env.PROGRAM_ID || process.env.ANCHOR_PROGRAM_ID;
  const newTreasuryRaw = args.newTreasuryAta || process.env.NEW_TREASURY_ATA;

  if (!authorityType) throw new Error('Missing --type <ops|withdraw> (or AUTHORITY_TYPE env)');
  if (!allyMintRaw) throw new Error('Missing --ally <ALLY_NFT_MINT>');
  if (!newAuthorityRaw) throw new Error('Missing --new <PUBKEY> (or NEW_AUTHORITY env)');
  if (!programIdRaw) throw new Error('Missing program id (--program or PROGRAM_ID env)');

  const authoritySource =
    args.authority ||
    (authorityType === 'ops' ? process.env.ALLY_OPS_KEYPAIR : process.env.ALLY_WITHDRAW_KEYPAIR) ||
    process.env.ADMIN_KEYPAIR;
  if (!authoritySource) throw new Error('Authority keypair not provided. Use --authority or set env.');

  const allyMint = parsePubkey(allyMintRaw);
  const newAuthority = parsePubkey(newAuthorityRaw);
  const programId = parsePubkey(programIdRaw);
  const authority = loadKeypair(authoritySource);

  const connection = new Connection(rpcUrl, 'confirmed');
  const provider = new anchor.AnchorProvider(connection, new (anchor as any).Wallet(authority), {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  anchor.setProvider(provider);

  const patchedIdl = { ...(rewardVaultIdl as RewardVault), address: programId.toBase58() };
  const program = new Program<RewardVault>(patchedIdl, provider);

  const [vaultStatePda] = PublicKey.findProgramAddressSync([Buffer.from('vault_state')], programId);
  const [allyPda] = PublicKey.findProgramAddressSync([Buffer.from('ally'), allyMint.toBuffer()], programId);

  const ally = await program.account.allyAccount.fetch(allyPda);
  console.log('=== Reward Vault :: Ally Authority Rotator ===');
  console.log(`RPC endpoint      : ${rpcUrl}`);
  console.log(`Program ID        : ${programId.toBase58()}`);
  console.log(`ally_nft_mint     : ${allyMint.toBase58()}`);
  console.log(`ally PDA          : ${allyPda.toBase58()}`);
  console.log(`authority type    : ${authorityType}`);
  console.log(`current ops auth  : ${ally.opsAuthority.toBase58()}`);
  console.log(`current wd auth   : ${ally.withdrawAuthority.toBase58()}`);
  console.log(`current treasury  : ${ally.treasuryAta.toBase58()}`);
  console.log(`new authority     : ${newAuthority.toBase58()}`);

  const expectedCurrent =
    authorityType === 'ops' ? ally.opsAuthority : ally.withdrawAuthority;
  const matches = expectedCurrent.equals(authority.publicKey);
  console.log(`signer pubkey     : ${authority.publicKey.toBase58()}${matches ? '' : ' (mismatch!)'}`);
  if (!matches && !args.dryRun) {
    throw new Error('Signer mismatch; cannot proceed without --dry-run.');
  }

  let newTreasuryAta: PublicKey | null = null;
  if (authorityType === 'withdraw') {
    const vaultState = await program.account.vaultState.fetch(vaultStatePda);
    if (newTreasuryRaw) {
      newTreasuryAta = parsePubkey(newTreasuryRaw);
      const acc = await getAccount(connection, newTreasuryAta, 'confirmed', TOKEN_PROGRAM_ID);
      if (!acc.mint.equals(vaultState.forcaMint)) {
        throw new Error('new treasury ATA mint does not match vault forca_mint');
      }
      if (!acc.owner.equals(newAuthority)) {
        throw new Error('new treasury ATA owner does not match new withdraw authority');
      }
    } else {
      const allowOffCurve = !PublicKey.isOnCurve(newAuthority.toBuffer());
      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        vaultState.forcaMint,
        newAuthority,
        allowOffCurve,
      );
      newTreasuryAta = ata.address;
    }
    console.log(`new treasury ATA  : ${newTreasuryAta.toBase58()}`);
  }

  if (args.dryRun) {
    console.log('[dry-run] Skipped sending transaction.');
    return;
  }

  let signature: string;
  try {
    if (authorityType === 'ops') {
      signature = await (program.methods as any)
        .setAllyOpsAuthority(newAuthority)
        .accounts({ opsAuthority: authority.publicKey, ally: allyPda })
        .rpc();
    } else {
      if (!newTreasuryAta) {
        throw new Error('new treasury ATA unresolved');
      }
      signature = await (program.methods as any)
        .setAllyWithdrawAuthority(newAuthority)
        .accounts({
          withdrawAuthority: authority.publicKey,
          ally: allyPda,
          vaultState: vaultStatePda,
          newTreasuryAta,
        })
        .rpc();
    }
  } catch (err: any) {
    if (err instanceof SendTransactionError) {
      console.error('Transaction simulation failed:', err.message);
      try {
        const logs: any = await (err as any).getLogs(connection as any);
        const lines: string[] = Array.isArray(logs)
          ? logs
          : (logs?.value?.logs as string[] | undefined) ?? [];
        if (lines.length) {
          console.error('RPC logs:');
          for (const line of lines) console.error(`  ${line}`);
        }
      } catch (logErr) {
        console.error('Unable to fetch transaction logs:', (logErr as Error).message);
      }
    }
    throw err;
  }

  console.log(`tx signature      : ${signature}`);
  const conf = await connection.confirmTransaction(signature, 'confirmed');
  if (conf.value.err) {
    console.error('Transaction error:', conf.value.err);
    throw new Error('set_ally_authority transaction failed');
  }
  console.log('Status            : confirmed');
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
