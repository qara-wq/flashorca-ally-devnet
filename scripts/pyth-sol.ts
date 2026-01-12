/*
 * Pyth SOL/USD oracle refresh
 *
 * Purpose:
 *   - Fetch latest SOL/USD update from Hermes
 *   - Optionally post it on-chain (PriceUpdateV2) and update the price feed
 *
 * Examples:
 *   Query:
 *     TS_NODE_TRANSPILE_ONLY=1 ts-node scripts/pyth-sol.ts --action query
 *
 *   Post update:
 *     TS_NODE_TRANSPILE_ONLY=1 ts-node scripts/pyth-sol.ts --post \
 *       --authority /path/to/keypair.json
 *
 *   Post + update feed:
 *     TS_NODE_TRANSPILE_ONLY=1 ts-node scripts/pyth-sol.ts --post --update-feed \
 *       --authority /path/to/keypair.json
 *
 * Options:
 *   --env <path>        Env file path (default: ../devnet.env)
 *   --rpc <url>         Override RPC_URL
 *   --hermes <url>      Override HERMES_URL
 *   --feed-id <hex>     Override SOL_USD_FEED_ID (0x optional)
 *   --action <mode>     query | post
 *   --post              Alias for --action post
 *   --update-feed       Also update the price feed account (shard=0)
 *   --authority <src>   Keypair (path / JSON / base58) for posting
 *   --cu-price <u64>    Compute unit price in micro-lamports
 *   --dry-run           Do not send transactions
 *   --help              Show help
 *
 * Environment fallbacks:
 *   RPC_URL, HERMES_URL, SOL_USD_FEED_ID,
 *   AUTHORITY_KEYPAIR, PAYER, PAYER_KEYPAIR, ADMIN_KEYPAIR,
 *   POST, UPDATE_FEED, CU_PRICE
 */

import * as fs from 'fs';
import * as path from 'path';
import { HermesClient } from '@pythnetwork/hermes-client';
import bs58 from 'bs58';

type Action = 'query' | 'post';

type CliOptions = {
  envPath?: string;
  action?: Action;
  rpcUrl?: string;
  hermesUrl?: string;
  feedId?: string;
  post?: boolean;
  updateFeed?: boolean;
  authority?: string;
  cuPrice?: string;
  dryRun?: boolean;
};

const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';
const DEFAULT_HERMES_URL = 'https://hermes.pyth.network';
const DEFAULT_SOL_USD_FEED_ID =
  '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
const DEFAULT_CU_PRICE = 100_000;

function printHelp() {
  console.log(`Pyth SOL/USD oracle refresh

Usage:
  ts-node scripts/pyth-sol.ts --action <query|post> [options]

Options:
  --env <path>        Load env file (default ../devnet.env)
  --rpc <url>         Override RPC_URL
  --hermes <url>      Override HERMES_URL
  --feed-id <hex>     Override SOL_USD_FEED_ID (0x optional)
  --action <mode>     query | post
  --post              Alias for --action post
  --update-feed       Also update the price feed account (shard=0)
  --authority <src>   Keypair (path / JSON / base58) for posting
  --cu-price <u64>    Compute unit price in micro-lamports
  --dry-run           Do not send transactions
  --help              Show this help

Environment fallbacks:
  RPC_URL, HERMES_URL, SOL_USD_FEED_ID,
  AUTHORITY_KEYPAIR, PAYER, PAYER_KEYPAIR, ADMIN_KEYPAIR,
  POST, UPDATE_FEED, CU_PRICE
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
        if (val === 'query' || val === 'post') opts.action = val as Action;
        else throw new Error(`Invalid action "${val}"`);
        break;
      }
      case '--rpc':
        opts.rpcUrl = valueFromEq ?? readNext();
        break;
      case '--hermes':
        opts.hermesUrl = valueFromEq ?? readNext();
        break;
      case '--feed-id':
        opts.feedId = valueFromEq ?? readNext();
        break;
      case '--post':
        opts.post = true;
        break;
      case '--update-feed':
        opts.updateFeed = true;
        break;
      case '--authority':
        opts.authority = valueFromEq ?? readNext();
        break;
      case '--cu-price':
        opts.cuPrice = valueFromEq ?? readNext();
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

function keypairFromString(raw: string, KeypairCtor: any) {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Empty keypair input');
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed);
    return KeypairCtor.fromSecretKey(Uint8Array.from(arr));
  }
  if (trimmed.startsWith('{')) {
    const obj = JSON.parse(trimmed);
    if (Array.isArray(obj)) return KeypairCtor.fromSecretKey(Uint8Array.from(obj));
    if (Array.isArray(obj.secretKey)) return KeypairCtor.fromSecretKey(Uint8Array.from(obj.secretKey));
    throw new Error('Unsupported JSON keypair format');
  }
  try {
    const decoded = bs58.decode(trimmed);
    return KeypairCtor.fromSecretKey(decoded);
  } catch (e) {
    throw new Error('Failed to parse keypair from provided string/base58');
  }
}

function loadKeypair(source: string, KeypairCtor: any) {
  const expanded = expandHome(source);
  if (fs.existsSync(expanded)) {
    const raw = fs.readFileSync(expanded, 'utf8');
    return keypairFromString(raw, KeypairCtor);
  }
  return keypairFromString(source, KeypairCtor);
}

function parseU64(input: string): bigint {
  const cleaned = input.replace(/[_,\s]/g, '');
  if (!/^\d+$/.test(cleaned)) throw new Error(`Invalid u64 "${input}"`);
  const value = BigInt(cleaned);
  if (value < 0n || value > 18446744073709551615n) throw new Error('u64 out of range');
  return value;
}

function parseU64ToNumber(input: string, label: string): number {
  const value = parseU64(input);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds MAX_SAFE_INTEGER`);
  }
  return Number(value);
}

function renderHermesPrice(parsed: any) {
  const expo = Number(parsed.price?.expo ?? parsed.ema_price?.expo ?? 0);
  const priceNum = Number(parsed.price?.price ?? 0);
  const confNum = Number(parsed.price?.conf ?? 0);
  const px = priceNum * Math.pow(10, expo);
  const cf = confNum * Math.pow(10, expo);
  console.log('Pyth SOL/USD (Hermes)');
  console.log('---------------------');
  console.log('price:       ', px);
  console.log('confidence:  +/-' + cf);
  console.log('exponent:    ', expo);
  console.log('publishTime: ', parsed.price?.publish_time);
}

function renderOnChainPrice(label: string, msg: any) {
  const expo = Number(msg.exponent);
  const px = Number(msg.price) * Math.pow(10, expo);
  const cf = Number(msg.conf) * Math.pow(10, expo);
  console.log(label);
  console.log('----------------------');
  console.log('price:       ', px);
  console.log('confidence:  +/-' + cf);
  console.log('exponent:    ', expo);
  console.log('publishTime: ', Number(msg.publishTime));
}

async function main() {
  const args = parseArgs();

  const envPath = args.envPath || process.env.ENV_PATH || path.resolve(__dirname, '../devnet.env');
  const envLoaded = loadEnvFile(envPath);
  if (envLoaded) console.log(`[env] Loaded ${envPath}`);

  const rpcUrl = args.rpcUrl || process.env.RPC_URL || DEFAULT_RPC_URL;
  const hermesUrl = args.hermesUrl || process.env.HERMES_URL || DEFAULT_HERMES_URL;
  const feedId = args.feedId || process.env.SOL_USD_FEED_ID || DEFAULT_SOL_USD_FEED_ID;

  const action: Action =
    args.action ||
    (args.post ||
    args.updateFeed ||
    process.env.POST === '1' ||
    process.env.UPDATE_FEED === '1'
      ? 'post'
      : 'query');
  const shouldPost = action === 'post';
  const updateFeed = Boolean(args.updateFeed || process.env.UPDATE_FEED === '1');
  const dryRun = Boolean(args.dryRun || process.env.DRY_RUN === '1');

  const cuPriceRaw = args.cuPrice || process.env.CU_PRICE || process.env.PRIORITY_FEE;
  const cuPrice = cuPriceRaw ? parseU64ToNumber(cuPriceRaw, 'CU price') : DEFAULT_CU_PRICE;

  console.log('=== Pyth SOL/USD Oracle ===');
  console.log(`RPC endpoint      : ${rpcUrl}`);
  console.log(`Hermes endpoint   : ${hermesUrl}`);
  console.log(`Feed ID           : ${feedId}`);
  console.log(`Action            : ${shouldPost ? 'post' : 'query'}`);
  if (shouldPost) {
    console.log(`Update feed       : ${updateFeed ? 'yes' : 'no'}`);
    console.log(`CU price          : ${cuPrice}`);
  }

  const hermes = new HermesClient(hermesUrl);
  const { parsed, binary } = await hermes.getLatestPriceUpdates([feedId], {
    encoding: 'base64',
    parsed: true,
  });
  if (!binary?.data?.length) throw new Error('No price update returned from Hermes');

  if (parsed && parsed.length > 0) {
    renderHermesPrice(parsed[0]);
  } else {
    console.log('Hermes returned', binary?.data?.length ?? 0, 'updates (base64)');
  }

  if (!shouldPost) return;

  const [{ PythSolanaReceiver }, anchorMod, web3] = await Promise.all([
    import('@pythnetwork/pyth-solana-receiver'),
    import('@coral-xyz/anchor'),
    import('@solana/web3.js'),
  ]);
  const { Connection, Keypair } = web3 as any;

  const authoritySource =
    args.authority ||
    process.env.AUTHORITY_KEYPAIR ||
    process.env.PAYER_KEYPAIR ||
    process.env.PAYER ||
    process.env.ADMIN_KEYPAIR;
  if (!authoritySource) {
    throw new Error('Authority keypair not provided. Use --authority or set AUTHORITY_KEYPAIR / PAYER / ADMIN_KEYPAIR.');
  }
  const authority = loadKeypair(authoritySource, Keypair);
  console.log(`Authority          : ${authority.publicKey.toBase58()}`);

  const connection = new Connection(rpcUrl, 'confirmed');
  const wallet = new (anchorMod as any).Wallet(authority);
  const receiver = new PythSolanaReceiver({ connection, wallet });

  const txb = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  await txb.addPostPriceUpdates(binary.data);

  const priceUpdateAccount = txb.getPriceUpdateAccount(feedId);
  const priceFeedAccount = receiver.getPriceFeedAccountAddress(0, feedId);
  console.log('priceUpdateAccount:', priceUpdateAccount.toBase58());
  console.log('priceFeedAccount (shard=0):', priceFeedAccount.toBase58());

  if (dryRun) {
    console.log('[dry-run] Skipped sending transactions.');
    return;
  }

  const txs = await txb.buildLegacyTransactions({
    computeUnitPriceMicroLamports: cuPrice,
    tightComputeBudget: true,
  });
  const sigs = await receiver.provider.sendAll(txs);
  console.log('Posted Pyth updates:', sigs);

  const acct = await receiver.fetchPriceUpdateAccount(priceUpdateAccount);
  if (!acct) throw new Error('failed to fetch PriceUpdateV2 account');
  const msg = (acct as any).priceMessage;
  renderOnChainPrice('On-chain PriceUpdateV2', msg);
  console.log('postedSlot:  ', String((acct as any).postedSlot));

  if (updateFeed) {
    const txb2 = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
    await txb2.addUpdatePriceFeed(binary.data, 0);
    const txs2 = await txb2.buildLegacyTransactions({
      computeUnitPriceMicroLamports: cuPrice,
      tightComputeBudget: true,
    });
    const sigs2 = await receiver.provider.sendAll(txs2);
    console.log('Updated Price Feed account (shard=0). txs:', sigs2);
  }

  const feedAcct = await receiver.fetchPriceFeedAccount(0, feedId);
  if (feedAcct) {
    const fmsg = (feedAcct as any).priceMessage;
    renderOnChainPrice('Price Feed (shard=0)', fmsg);
  } else {
    console.log('Price Feed account not found or not initialized yet.');
    console.log('Tip: run with --update-feed once to initialize the feed account.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
