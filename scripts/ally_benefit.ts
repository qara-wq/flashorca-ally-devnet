/*
 * Ally Benefit Controller
 *
 * 기능:
 *   - Ally 혜택(할인/보너스PP/없음) 조회 또는 설정
 *
 * 사용 예시:
 *   조회:
 *     ts-node scripts/ally_benefit.ts --action query \
 *       --ally 8b1sr6ZyBY68DvwZmfTBVu4b9Lyi9PthB9LU3PH2PBhF
 *
 *   설정(할인 15%):
 *     ts-node scripts/ally_benefit.ts --action set --mode discount --bps 1500 \
 *       --ally 8b1sr6ZyBY68DvwZmfTBVu4b9Lyi9PthB9LU3PH2PBhF \
 *       --authority ~/.config/solana/ally.json
 *
 * 옵션:
 *   --env <path>         .env 파일 경로 (기본: ../devnet.env)
 *   --action <mode>      query | set
 *   --ally <pubkey>      Ally NFT mint 주소 (필수)
 *   --mode <m>           none | discount | bonus (set 시 필수)
 *   --bps <u16>          bps (0~10000) (set 시 필수)
 *   --authority <src>    ops authority 키페어 (파일/JSON/base58)
 *   --program <id>       프로그램 ID 재지정 (선택)
 *   --dry-run            set 시 트랜잭션 전송 생략
 */

import * as fs from 'fs';
import * as path from 'path';
import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram, SendTransactionError } from '@solana/web3.js';
import bs58 from 'bs58';

import idl from '../target/idl/reward_vault.json';
import { RewardVault } from '../target/types/reward_vault';

type Action = 'query' | 'set';
type Mode = 'none' | 'discount' | 'bonus';

type CliOptions = {
  envPath?: string;
  action?: Action;
  allyMint?: string;
  mode?: Mode;
  bps?: string;
  authority?: string;
  programId?: string;
  dryRun?: boolean;
};

function printHelp() {
  console.log(`Ally Benefit Controller\n\nUsage:\n  ts-node scripts/ally_benefit.ts --action <query|set> --ally <ALLY_NFT_MINT> [options]\n\nOptions:\n  --env <path>        Load env file (default ../devnet.env)\n  --action <mode>     query | set\n  --ally <pubkey>     Ally NFT mint\n  --mode <m>          none | discount | bonus (for set)\n  --bps <u16>         0..10000 (for set)\n  --authority <src>   Ops authority keypair (path / JSON / base58)\n  --program <id>      Override program id\n  --dry-run           Skip submitting tx for set\n`);
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
        printHelp();
        process.exit(0);
      case '--env':
        opts.envPath = valueFromEq ?? readNext(); break;
      case '--action': {
        const v = (valueFromEq ?? readNext()).toLowerCase();
        if (v === 'query' || v === 'set') opts.action = v; else throw new Error(`Invalid action ${v}`);
        break;
      }
      case '--ally':
        opts.allyMint = valueFromEq ?? readNext(); break;
      case '--mode': {
        const v = (valueFromEq ?? readNext()).toLowerCase();
        if (v === 'none' || v === 'discount' || v === 'bonus') opts.mode = v as Mode; else throw new Error(`Invalid mode ${v}`);
        break;
      }
      case '--bps':
        opts.bps = valueFromEq ?? readNext(); break;
      case '--authority':
        opts.authority = valueFromEq ?? readNext(); break;
      case '--program':
        opts.programId = valueFromEq ?? readNext(); break;
      case '--dry-run':
        opts.dryRun = true; break;
      default:
        console.warn(`Unrecognized argument ignored: ${flag}`);
    }
  }
  return opts;
}

function expandHome(p: string) { return p && p.startsWith('~') ? path.join(process.env.HOME || '', p.slice(1)) : p; }
function unquote(v: string) { if (!v) return v; if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1); return v; }
function loadEnvFile(filePath: string): boolean {
  if (!filePath) return false; const fp = expandHome(filePath); if (!fs.existsSync(fp)) return false;
  const lines = fs.readFileSync(fp, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const s = line.trim(); if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('='); if (eq === -1) continue; const k = s.slice(0, eq).trim(); if (!k || process.env[k] !== undefined) continue;
    process.env[k] = unquote(s.slice(eq + 1).trim());
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
  try { return Keypair.fromSecretKey(bs58.decode(trimmed)); } catch { /* fallthrough */ }
  // Assume file path
  const fp = expandHome(trimmed); const rawFile = fs.readFileSync(fp, 'utf8');
  const maybeJson = JSON.parse(rawFile);
  const arr = Array.isArray(maybeJson) ? maybeJson : maybeJson.secretKey;
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

function parseU16(input: string): number {
  const v = Number((input || '').replace(/[_\s]/g, ''));
  if (!Number.isFinite(v) || v < 0 || v > 65535) throw new Error(`Invalid u16: ${input}`);
  return v;
}

function modeToVariant(mode: Mode): any {
  switch (mode) {
    case 'none': return { none: {} };
    case 'discount': return { discount: {} };
    case 'bonus': return { bonusPp: {} };
    default: throw new Error(`Unknown mode ${mode}`);
  }
}

function formatBps(bps: number) { return `${bps} bps (${(bps / 100).toFixed(2)}%)`; }

function benefitModeToText(v: number): string {
  switch (v) {
    case 0: return 'None(0)';
    case 1: return 'Discount(1)';
    case 2: return 'BonusPP(2)';
    default: return `Unknown(${v})`;
  }
}

async function main() {
  const args = parseArgs();
  const envPath = args.envPath || path.resolve(__dirname, '../devnet.env');
  loadEnvFile(envPath) && console.log(`[env] Loaded ${envPath}`);

  const rpcUrl = process.env.RPC_URL || 'https://api.devnet.solana.com';
  const allyMintRaw = args.allyMint || process.env.ALLY_NFT_MINT || (() => { throw new Error('Ally mint not provided. Use --ally.'); })();

  const action: Action = args.action || (() => { throw new Error('Missing --action query|set'); })();
  const programIdRaw = args.programId || process.env.PROGRAM_ID || (idl as any).address;
  const programId = new PublicKey(programIdRaw!);

  const connection = new Connection(rpcUrl, 'confirmed');
  const idlJson: any = { ...(idl as any), address: programId.toBase58() };
  // 초기 조회용 provider (query 전용)
  const readProvider = new anchor.AnchorProvider(connection, new (anchor as any).Wallet(Keypair.generate()), {});
  let program = new Program(idlJson, readProvider) as Program<RewardVault>;

  const allyMint = new PublicKey(allyMintRaw!);
  const [allyPda] = await PublicKey.findProgramAddress([Buffer.from('ally'), allyMint.toBuffer()], program.programId);

  console.log('[1] Fetch ally account');
  const ally = await program.account.allyAccount.fetchNullable(allyPda);
  if (!ally) throw new Error(`Ally account not found at ${allyPda.toBase58()}. 먼저 register_ally를 수행하세요.`);
  console.log(`    ally PDA      : ${allyPda.toBase58()}`);
  console.log(`    ops auth      : ${ally.opsAuthority.toBase58()}`);
  console.log(`    withdraw auth : ${ally.withdrawAuthority.toBase58()}`);
  console.log(`    benefit_mode  : ${benefitModeToText(ally.benefitMode)}`);
  console.log(`    benefit_bps   : ${ally.benefitBps}`);

  if (action === 'query') {
    console.log('\nNo transaction sent (query).');
    return;
  }

  const mode: Mode = args.mode || (() => { throw new Error('Missing --mode none|discount|bonus'); })();
  const bps = parseU16(args.bps || (() => { throw new Error('Missing --bps'); })() as string);
  if (bps > 10000) throw new Error('bps must be <= 10000');
  const authoritySrc = args.authority || process.env.ALLY_OPS_KEYPAIR || process.env.ALLY_SETTLE_KEYPAIR || process.env.ADMIN_KEYPAIR || (() => { throw new Error('Missing --authority or env ALLY_OPS_KEYPAIR'); })();
  const signer = keypairFromString(authoritySrc);
  // 송신용 provider를 signer로 구성 (fee payer = signer)
  const writeProvider = new anchor.AnchorProvider(connection, new (anchor as any).Wallet(signer), {});
  program = new Program(idlJson, writeProvider) as Program<RewardVault>;

  if (ally.opsAuthority.toBase58() !== signer.publicKey.toBase58()) {
    console.warn('    WARNING: provided signer does not match ally.ops_authority');
  }

  if (args.dryRun) {
    console.log(`\n[dry-run] set_ally_benefit ${mode} ${formatBps(bps)}`);
    return;
  }

  console.log('\n[2] Sending set_ally_benefit');
  const variant = modeToVariant(mode);
  try {
    const sig = await (program.methods
      .setAllyBenefit(variant as any, bps)
      .accounts({ opsAuthority: signer.publicKey, ally: allyPda } as any)
      .signers([signer])
      .rpc());
    console.log(`    tx signature: ${sig}`);
  } catch (err: any) {
    if (err instanceof SendTransactionError) {
      console.error('Simulation failed:', err.message);
      try {
        const logs = await err.getLogs(connection as any);
        if (logs?.value?.logs?.length) {
          console.error('RPC logs:');
          for (const line of logs.value.logs) console.error(`  ${line}`);
        }
      } catch (_) {}
    }
    throw err;
  }

  const updated = await program.account.allyAccount.fetch(allyPda);
  console.log('\n[3] Updated ally');
  console.log(`    benefit_mode  : ${benefitModeToText(updated.benefitMode)}`);
  console.log(`    benefit_bps   : ${updated.benefitBps}`);
  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
