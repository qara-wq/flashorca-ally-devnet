import { Buffer } from 'buffer';
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { Commitment } from '@solana/web3.js';

export type PopLevelLabel = 'Suspicious' | 'Soft' | 'Strong' | 'Unknown';

export type AllyConfig = {
  mint: PublicKey;
  mintAddress: string;
  label: string;
};

export type RewardVaultConfig = {
  programId: PublicKey;
  allies: AllyConfig[];
  poolForcaReserve?: PublicKey;
  poolSolReserve?: PublicKey;
  canonicalPoolAuthority?: PublicKey;
  pythPriceFeedAccount?: PublicKey;
  pythFeedId?: string;
  pythFeedShard: number;
  pythHermesUrl: string;
  pythMaxStaleSecs: number;
};

export type PopProfileData = {
  address: PublicKey;
  levelIndex: number;
  levelLabel: PopLevelLabel;
  lastSetTs: number | null;
};

export type UserLedgerData = {
  address: PublicKey;
  ally: AllyConfig;
  exists: boolean;
  rpClaimable: bigint;
  ppBalance: bigint;
  hwmClaimed: bigint;
  taxHwm: bigint;
  totalClaimedForca: bigint;
  createdTs: number | null;
  updatedTs: number | null;
};

export type ClaimGuardData = {
  address: PublicKey;
  user: PublicKey;
  allyMint: PublicKey;
  day: bigint | null;
  usedUsdE6: bigint;
  lastClaimTs: bigint | null;
  monthIndex: bigint | null;
  monthClaims: number;
  bump: number;
  exists: boolean;
};

export type RewardVaultSnapshot = {
  popProfile: PopProfileData | null;
  ledgers: UserLedgerData[];
  claimGuards: Record<string, ClaimGuardData>;
};

export type FetchRewardSnapshotOptions = {
  commitment?: Commitment;
};

const DEFAULT_PROGRAM_ID = '2SBFs9cnkv6NZjM28a87ysPr7zvPWj7KuQC4WW16nGS7';
const DEFAULT_ALLIES = [
  {
    mint: '8b1sr6ZyBY68DvwZmfTBVu4b9Lyi9PthB9LU3PH2PBhF',
    label: 'Reward-fest! Ally',
  },
];

const POP_LEVEL_LABELS: Record<number, PopLevelLabel> = {
  0: 'Suspicious',
  1: 'Soft',
  2: 'Strong',
};

const POP_PROFILE_SIZE = 8 + 32 + 1 + 1 + 8;
const USER_LEDGER_SIZE = 8 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 1 + 8 + 8;

const SEED_POP = Buffer.from('pop');
const SEED_USER_LEDGER = Buffer.from('user_ledger');
const SEED_VAULT_STATE = Buffer.from('vault_state');
const SEED_VAULT_SIGNER = Buffer.from('vault_signer');
const SEED_ALLY = Buffer.from('ally');
const SEED_ALLY_VAULT = Buffer.from('ally_vault');
const SEED_MOCK_ORACLE_SOL = Buffer.from('mock_oracle_sol');
const SEED_MOCK_POOL_FORCA = Buffer.from('mock_pool_forca');
const SEED_CLAIM_GUARD = Buffer.from('claim_guard');

const IX_CONVERT_TO_SCOPED_PP_DISCRIMINATOR = Buffer.from([112, 238, 195, 2, 143, 214, 143, 89]);
const IX_CLAIM_RP_DISCRIMINATOR = Buffer.from([89, 196, 234, 5, 100, 197, 24, 219]);

function makeAllyConfig(mint: string, label?: string): AllyConfig | null {
  try {
    const pk = new PublicKey(mint);
    const trimmedLabel = label?.trim();
    const fallbackLabel =
      trimmedLabel && trimmedLabel.length > 0
        ? trimmedLabel
        : `${pk.toBase58().slice(0, 4)}…${pk.toBase58().slice(-4)}`;
    return {
      mint: pk,
      mintAddress: pk.toBase58(),
      label: fallbackLabel,
    };
  } catch {
    return null;
  }
}

function parseAllies(raw?: string): AllyConfig[] {
  if (!raw) return [];
  const out: AllyConfig[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [mint, label] = trimmed.split(':', 2);
    const cfg = makeAllyConfig(mint.trim(), label);
    if (cfg) out.push(cfg);
  }
  return out;
}

function defaultAllies(): AllyConfig[] {
  const out: AllyConfig[] = [];
  for (const entry of DEFAULT_ALLIES) {
    const cfg = makeAllyConfig(entry.mint, entry.label);
    if (cfg) out.push(cfg);
  }
  return out;
}

export function getRewardVaultConfig(): RewardVaultConfig {
  const rawProgramId = (import.meta.env.VITE_REWARD_VAULT_PROGRAM_ID ?? '').trim();
  let programId: PublicKey;
  try {
    programId = new PublicKey(rawProgramId || DEFAULT_PROGRAM_ID);
  } catch {
    programId = new PublicKey(DEFAULT_PROGRAM_ID);
  }

  const envAllies = parseAllies(import.meta.env.VITE_REWARD_VAULT_ALLIES as string | undefined);
  const allies = envAllies.length > 0 ? envAllies : defaultAllies();

  const parsePk = (value?: string): PublicKey | undefined => {
    if (!value) return undefined;
    try {
      const trimmed = value.trim();
      if (!trimmed) return undefined;
      return new PublicKey(trimmed);
    } catch {
      return undefined;
    }
  };

  const poolForcaReserve = parsePk(import.meta.env.VITE_REWARD_VAULT_POOL_FORCA_RESERVE as string | undefined);
  const poolSolReserve = parsePk(import.meta.env.VITE_REWARD_VAULT_POOL_SOL_RESERVE as string | undefined);
  const canonicalPoolAuthority = parsePk(import.meta.env.VITE_REWARD_VAULT_CANONICAL_POOL_AUTHORITY as string | undefined);
  const pythPriceFeedAccount = parsePk(import.meta.env.VITE_PYTH_PRICE_FEED_ACCOUNT as string | undefined);
  const feedIdRaw = (import.meta.env.VITE_PYTH_SOL_USD_FEED_ID as string | undefined)?.trim();
  const pythFeedId = feedIdRaw && feedIdRaw.length > 0 ? feedIdRaw : undefined;
  const shardRaw = (import.meta.env.VITE_PYTH_FEED_SHARD as string | undefined)?.trim();
  let pythFeedShard = 0;
  if (shardRaw) {
    const parsedShard = Number(shardRaw);
    if (Number.isFinite(parsedShard) && parsedShard >= 0) {
      pythFeedShard = parsedShard;
    }
  }
  const hermesRaw = (import.meta.env.VITE_PYTH_HERMES_URL as string | undefined)?.trim();
  const pythHermesUrl = hermesRaw && hermesRaw.length > 0 ? hermesRaw : 'https://hermes.pyth.network';
  const maxStaleRaw = (import.meta.env.VITE_PYTH_MAX_STALE_SECS as string | undefined)?.trim();
  let pythMaxStaleSecs = 60;
  if (maxStaleRaw) {
    const parsedMax = Number(maxStaleRaw);
    if (Number.isFinite(parsedMax) && parsedMax > 0) {
      pythMaxStaleSecs = parsedMax;
    }
  }

  return {
    programId,
    allies,
    poolForcaReserve,
    poolSolReserve,
    canonicalPoolAuthority,
    pythPriceFeedAccount,
    pythFeedId,
    pythFeedShard,
    pythHermesUrl,
    pythMaxStaleSecs,
  };
}

function ensureBuffer(data: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function parsePopProfile(data: Buffer, address: PublicKey): PopProfileData | null {
  if (data.length < POP_PROFILE_SIZE) return null;
  const levelIndex = data.readUInt8(8 + 32);
  const lastSetRaw = data.readBigInt64LE(8 + 32 + 1 + 1);
  const lastSetTs = Number(lastSetRaw);

  return {
    address,
    levelIndex,
    levelLabel: POP_LEVEL_LABELS[levelIndex] ?? 'Unknown',
    lastSetTs: Number.isFinite(lastSetTs) && lastSetTs > 0 ? lastSetTs : null,
  };
}

function parseUserLedger(data: Buffer, ally: AllyConfig, address: PublicKey): UserLedgerData | null {
  if (data.length < USER_LEDGER_SIZE) return null;

  const rpOffset = 8 + 32 + 32;
  const ppOffset = rpOffset + 8;
  const hwmOffset = ppOffset + 8;
  const taxOffset = hwmOffset + 8;
  const totalOffset = taxOffset + 8;
  const bumpOffset = totalOffset + 8;
  const createdOffset = bumpOffset + 1;
  const updatedOffset = createdOffset + 8;

  const rpClaimable = data.readBigUInt64LE(rpOffset);
  const ppBalance = data.readBigUInt64LE(ppOffset);
  const hwmClaimed = data.readBigUInt64LE(hwmOffset);
  const taxHwm = data.readBigUInt64LE(taxOffset);
  const totalClaimedForca = data.readBigUInt64LE(totalOffset);
  const createdTsRaw = data.readBigInt64LE(createdOffset);
  const updatedTsRaw = data.readBigInt64LE(updatedOffset);

  const createdTs = Number(createdTsRaw);
  const updatedTs = Number(updatedTsRaw);

  return {
    address,
    ally,
    exists: true,
    rpClaimable,
    ppBalance,
    hwmClaimed,
    taxHwm,
    totalClaimedForca,
    createdTs: Number.isFinite(createdTs) && createdTs > 0 ? createdTs : null,
    updatedTs: Number.isFinite(updatedTs) && updatedTs > 0 ? updatedTs : null,
  };
}

function parseClaimGuard(data: Buffer, address: PublicKey): ClaimGuardData | null {
  // discriminator skipped; expected layout: user(32) ally(32) day(i64) used(u64) last_ts(i64) month_idx(i64) month_claims(u16) bump(u8)
  let offset = 8;
  if (data.length < offset + 32 + 32 + 8 + 8 + 8 + 8 + 2 + 1) return null;
  const user = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const allyMint = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const day = data.readBigInt64LE(offset); offset += 8;
  const usedUsdE6 = data.readBigUInt64LE(offset); offset += 8;
  const lastClaimTs = data.readBigInt64LE(offset); offset += 8;
  const monthIndex = data.readBigInt64LE(offset); offset += 8;
  const monthClaims = data.readUInt16LE(offset); offset += 2;
  const bump = data.readUInt8(offset);
  return {
    address,
    user,
    allyMint,
    day,
    usedUsdE6,
    lastClaimTs,
    monthIndex,
    monthClaims,
    bump,
    exists: true,
  };
}

export async function fetchRewardVaultSnapshot(
  connection: Connection,
  user: PublicKey,
  config: RewardVaultConfig,
  options: FetchRewardSnapshotOptions = {},
): Promise<RewardVaultSnapshot> {
  const commitment = options.commitment ?? 'confirmed';

  const [popProfilePda] = PublicKey.findProgramAddressSync(
    [SEED_POP, user.toBuffer()],
    config.programId,
  );
  const popInfo = await connection.getAccountInfo(popProfilePda, commitment);
  const popProfile = popInfo ? parsePopProfile(ensureBuffer(popInfo.data), popProfilePda) : null;

  const ledgers = await Promise.all(
    config.allies.map(async (ally) => {
      const [ledgerPda] = PublicKey.findProgramAddressSync(
        [SEED_USER_LEDGER, user.toBuffer(), ally.mint.toBuffer()],
        config.programId,
      );
      const info = await connection.getAccountInfo(ledgerPda, commitment);
      if (!info) {
        return {
          address: ledgerPda,
          ally,
          exists: false,
          rpClaimable: 0n,
          ppBalance: 0n,
          hwmClaimed: 0n,
          taxHwm: 0n,
          totalClaimedForca: 0n,
          createdTs: null,
          updatedTs: null,
        } satisfies UserLedgerData;
      }
      const parsed = parseUserLedger(ensureBuffer(info.data), ally, ledgerPda);
      if (!parsed) {
        return {
          address: ledgerPda,
          ally,
          exists: false,
          rpClaimable: 0n,
          ppBalance: 0n,
          hwmClaimed: 0n,
          taxHwm: 0n,
          totalClaimedForca: 0n,
          createdTs: null,
          updatedTs: null,
        } satisfies UserLedgerData;
      }
      return parsed;
    }),
  );

  // Claim guards per ally
  const claimGuards: Record<string, ClaimGuardData> = {};
  for (const ally of config.allies) {
    const [guardPda] = PublicKey.findProgramAddressSync(
      [SEED_CLAIM_GUARD, user.toBuffer(), ally.mint.toBuffer()],
      config.programId,
    );
    const info = await connection.getAccountInfo(guardPda, commitment);
    if (!info) {
      claimGuards[ally.mintAddress] = {
        address: guardPda,
        user,
        allyMint: ally.mint,
        day: null,
        usedUsdE6: 0n,
        lastClaimTs: null,
        monthIndex: null,
        monthClaims: 0,
        bump: 0,
        exists: false,
      };
    } else {
      const parsed = parseClaimGuard(ensureBuffer(info.data), guardPda);
      claimGuards[ally.mintAddress] = parsed ?? {
        address: guardPda,
        user,
        allyMint: ally.mint,
        day: null,
        usedUsdE6: 0n,
        lastClaimTs: null,
        monthIndex: null,
        monthClaims: 0,
        bump: 0,
        exists: false,
      };
    }
  }

  return { popProfile, ledgers, claimGuards };
}

export function formatAmount(value: bigint, decimals: number, unit?: string): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let fraction = (abs % base).toString().padStart(decimals, '0');
  fraction = fraction.replace(/0+$/, '');
  if (fraction.length > 6) fraction = fraction.slice(0, 6);

  const body = fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
  return `${negative ? '-' : ''}${body}${unit ? ` ${unit}` : ''}`;
}

export function formatTimestamp(ts: number | null): string {
  if (!ts) return 'not set';
  const date = new Date(ts * 1000);
  if (Number.isNaN(date.getTime())) return String(ts);
  return date.toLocaleString(undefined, { hour12: false });
}

export type VaultStateAccount = {
  address: PublicKey;
  popAdmin: PublicKey;
  econAdmin: PublicKey;
  forcaMint: PublicKey;
  feeCBps: number;
  taxDBps: number;
  marginBBps: number;
  paused: boolean;
  vaultSignerBump: number;
  softDailyCapUsdE6: bigint;
  softCooldownSecs: bigint;
  forcaUsdE6: bigint;
  verifyPrices: boolean;
  oracleToleranceBps: number;
  pythSolUsdPriceFeed: PublicKey;
  canonicalPoolForcaSol: PublicKey;
  canonicalPoolForcaReserve: PublicKey;
  canonicalPoolSolReserve: PublicKey;
  useMockOracle: boolean;
  mockOracleLocked: boolean;
  pythMaxStaleSecs: bigint;
  pythMaxConfidenceBps: number;
};

export type AllyAccountState = {
  address: PublicKey;
  nftMint: PublicKey;
  opsAuthority: PublicKey;
  withdrawAuthority: PublicKey;
  treasuryAta: PublicKey;
  vaultAta: PublicKey;
  role: number;
  balanceForca: bigint;
  rpReserved: bigint;
  benefitMode: number;
  benefitBps: number;
  popEnforced: boolean;
  softDailyCapUsdE6: bigint;
  softCooldownSecs: bigint;
  monthlyClaimLimit: number;
  hardKycThresholdUsdE6: bigint;
};

export type MockOracleSolUsdAccount = {
  address: PublicKey;
  solUsdE6: bigint;
  expoI32: number;
  confE8: bigint;
  publishTs: bigint;
};

export type MockPoolForcaSolAccount = {
  address: PublicKey;
  forcaPerSolE6: bigint;
  reserveForcaE6: bigint;
  reserveSolE9: bigint;
};

export type AnchorPriceMessage = {
  price: bigint;
  conf: bigint;
  expo: number;
  publishTime: bigint;
};

export type ConvertToScopedPPAccounts = {
  user: PublicKey;
  userAta: PublicKey;
  vaultState: PublicKey;
  ally: PublicKey;
  nftMint: PublicKey;
  allyVaultAta: PublicKey;
  userLedger: PublicKey;
  tokenProgram: PublicKey;
  systemProgram: PublicKey;
  pythSolUsdPriceFeed: PublicKey;
  canonicalPoolForcaSol: PublicKey;
  mockOracleSol: PublicKey;
  mockPoolForca: PublicKey;
  poolForcaReserve: PublicKey;
  poolSolReserve: PublicKey;
};

export type ClaimRPAccounts = {
  user: PublicKey;
  userAta: PublicKey;
  ally: PublicKey;
  vaultState: PublicKey;
  vaultSigner: PublicKey;
  allyVaultAta: PublicKey;
  userLedger: PublicKey;
  tokenProgram: PublicKey;
  popProfile: PublicKey;
  claimGuard: PublicKey;
  pythSolUsdPriceFeed: PublicKey;
  canonicalPoolForcaSol: PublicKey;
  mockOracleSol: PublicKey;
  mockPoolForca: PublicKey;
  poolForcaReserve: PublicKey;
  poolSolReserve: PublicKey;
  systemProgram: PublicKey;
};

export function deriveVaultStatePda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([SEED_VAULT_STATE], programId)[0];
}

export function deriveVaultSignerPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([SEED_VAULT_SIGNER], programId)[0];
}

export function deriveAllyPda(programId: PublicKey, allyMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([SEED_ALLY, allyMint.toBuffer()], programId)[0];
}

export function deriveAllyVaultPda(programId: PublicKey, allyMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([SEED_ALLY_VAULT, allyMint.toBuffer()], programId)[0];
}

export function deriveUserLedgerPda(programId: PublicKey, user: PublicKey, allyMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([SEED_USER_LEDGER, user.toBuffer(), allyMint.toBuffer()], programId)[0];
}

export function derivePopProfilePda(programId: PublicKey, user: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([SEED_POP, user.toBuffer()], programId)[0];
}

export function deriveClaimGuardPda(programId: PublicKey, user: PublicKey, allyMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([SEED_CLAIM_GUARD, user.toBuffer(), allyMint.toBuffer()], programId)[0];
}

export function deriveMockOracleSolPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([SEED_MOCK_ORACLE_SOL], programId)[0];
}

export function deriveMockPoolForcaPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([SEED_MOCK_POOL_FORCA], programId)[0];
}

async function fetchAccountBuffer(
  connection: Connection,
  address: PublicKey,
  commitment: Commitment = 'processed',
): Promise<Buffer | null> {
  const info = await connection.getAccountInfo(address, commitment);
  if (!info) return null;
  return ensureBuffer(info.data);
}

function parseVaultStateAccount(data: Buffer, address: PublicKey): VaultStateAccount | null {
  try {
    let offset = 8;
    const readPubkey = () => {
      const pk = new PublicKey(data.subarray(offset, offset + 32));
      offset += 32;
      return pk;
    };
    const readU16 = () => {
      const v = data.readUInt16LE(offset);
      offset += 2;
      return v;
    };
    const readU8 = () => {
      const v = data.readUInt8(offset);
      offset += 1;
      return v;
    };
    const readBool = () => {
      const v = data.readUInt8(offset);
      offset += 1;
      return v !== 0;
    };
    const readU64 = () => {
      const v = data.readBigUInt64LE(offset);
      offset += 8;
      return v;
    };

    const popAdmin = readPubkey();
    const econAdmin = readPubkey();
    const forcaMint = readPubkey();
    const feeCBps = readU16();
    const taxDBps = readU16();
    const marginBBps = readU16();
    const paused = readBool();
    const vaultSignerBump = readU8();
    const softDailyCapUsdE6 = readU64();
    const softCooldownSecs = readU64();
    const forcaUsdE6 = readU64();
    const verifyPrices = readBool();
    const oracleToleranceBps = readU16();
    const pythSolUsdPriceFeed = readPubkey();
    const canonicalPoolForcaSol = readPubkey();
    const canonicalPoolForcaReserve = readPubkey();
    const canonicalPoolSolReserve = readPubkey();
    const useMockOracle = readBool();
    const mockOracleLocked = readBool();
    const pythMaxStaleSecs = readU64();
    const pythMaxConfidenceBps = offset + 2 <= data.length ? readU16() : 0;

    return {
      address,
      popAdmin,
      econAdmin,
      forcaMint,
      feeCBps,
      taxDBps,
      marginBBps,
      paused,
      vaultSignerBump,
      softDailyCapUsdE6,
      softCooldownSecs,
      forcaUsdE6,
      verifyPrices,
      oracleToleranceBps,
      pythSolUsdPriceFeed,
      canonicalPoolForcaSol,
      canonicalPoolForcaReserve,
      canonicalPoolSolReserve,
      useMockOracle,
      mockOracleLocked,
      pythMaxStaleSecs,
      pythMaxConfidenceBps,
    };
  } catch {
    return null;
  }
}

function parseAllyAccount(data: Buffer, address: PublicKey): AllyAccountState | null {
  try {
    let offset = 8;
    const readPubkey = () => {
      const pk = new PublicKey(data.subarray(offset, offset + 32));
      offset += 32;
      return pk;
    };
    const readU8 = () => {
      const v = data.readUInt8(offset);
      offset += 1;
      return v;
    };
    const readU64 = () => {
      const v = data.readBigUInt64LE(offset);
      offset += 8;
      return v;
    };
    const readU16 = () => {
      const v = data.readUInt16LE(offset);
      offset += 2;
      return v;
    };
    const readBool = () => {
      const v = data.readUInt8(offset);
      offset += 1;
      return v !== 0;
    };

    const nftMint = readPubkey();
    const opsAuthority = readPubkey();
    const withdrawAuthority = readPubkey();
    const treasuryAta = readPubkey();
    const vaultAta = readPubkey();
    const role = readU8();
    const balanceForca = readU64();
    const rpReserved = readU64();
    const benefitMode = readU8();
    const benefitBps = readU16();
    const popEnforced = readBool();
    const softDailyCapUsdE6 = readU64();
    const softCooldownSecs = readU64();
    const monthlyClaimLimit = readU16();
    const hardKycThresholdUsdE6 = readU64();

    return {
      address,
      nftMint,
      opsAuthority,
      withdrawAuthority,
      treasuryAta,
      vaultAta,
      role,
      balanceForca,
      rpReserved,
      benefitMode,
      benefitBps,
      popEnforced,
      softDailyCapUsdE6,
      softCooldownSecs,
      monthlyClaimLimit,
      hardKycThresholdUsdE6,
    };
  } catch {
    return null;
  }
}

function parseMockOracleSol(data: Buffer, address: PublicKey): MockOracleSolUsdAccount | null {
  try {
    let offset = 8;
    const solUsdE6 = data.readBigUInt64LE(offset);
    offset += 8;
    const expoI32 = data.readInt32LE(offset);
    offset += 4;
    const confE8 = data.readBigUInt64LE(offset);
    offset += 8;
    const publishTs = data.readBigInt64LE(offset);

    return {
      address,
      solUsdE6,
      expoI32,
      confE8,
      publishTs,
    };
  } catch {
    return null;
  }
}

function parseMockPoolForca(data: Buffer, address: PublicKey): MockPoolForcaSolAccount | null {
  try {
    let offset = 8;
    const forcaPerSolE6 = data.readBigUInt64LE(offset);
    offset += 8;
    const reserveForcaE6 = data.readBigUInt64LE(offset);
    offset += 8;
    const reserveSolE9 = data.readBigUInt64LE(offset);

    return {
      address,
      forcaPerSolE6,
      reserveForcaE6,
      reserveSolE9,
    };
  } catch {
    return null;
  }
}

export function parseAnchorPriceMessageAccount(data: Buffer): AnchorPriceMessage | null {
  const need = 8 + 32 + 1 + 32 + 8 + 8 + 4 + 8;
  if (data.length < need) return null;
  let offset = 8 + 32;
  const tag = data.readUInt8(offset);
  offset += 1;
  if (tag === 0) {
    if (offset + 1 > data.length) return null;
    offset += 1;
  } else if (tag !== 1) {
    return null;
  }
  if (offset + 32 + 8 + 8 + 4 + 8 > data.length) return null;
  offset += 32;
  const price = data.readBigInt64LE(offset);
  offset += 8;
  const conf = data.readBigUInt64LE(offset);
  offset += 8;
  const expo = data.readInt32LE(offset);
  offset += 4;
  const publishTime = data.readBigInt64LE(offset);
  return { price, conf, expo, publishTime };
}

export function scalePriceToMicroUsd(price: bigint, expo: number): bigint | null {
  let value = price;
  const adj = expo + 6;
  try {
    if (adj > 0) {
      let factor = 1n;
      for (let i = 0; i < adj; i++) {
        factor *= 10n;
      }
      value *= factor;
    } else if (adj < 0) {
      let factor = 1n;
      for (let i = 0; i < -adj; i++) {
        factor *= 10n;
      }
      value /= factor;
    }
  } catch {
    return null;
  }
  if (value < 0) return null;
  return value;
}

export function parsePythPriceAccount(data: Buffer): AnchorPriceMessage | null {
  const MAGIC = 0xa1b2c3d4;
  const TYPE_PRICE = 3;
  const AGGREGATION_OFFSET = 208;
  if (data.length < AGGREGATION_OFFSET + 32) return null;
  if (data.readUInt32LE(0) !== MAGIC) return null;
  const ver = data.readUInt32LE(4);
  if (!(ver === 2 || ver === 3)) return null;
  const accountType = data.readUInt32LE(8);
  if (accountType !== TYPE_PRICE) return null;
  const expo = data.readInt32LE(20);
  const price = data.readBigInt64LE(AGGREGATION_OFFSET);
  const conf = data.readBigUInt64LE(AGGREGATION_OFFSET + 8);
  const status = data.readUInt32LE(AGGREGATION_OFFSET + 16);
  if (status === 0) return null;
  const publishTime = data.readBigInt64LE(AGGREGATION_OFFSET + 24);
  if (price === 0n) return null;
  return { price, conf, expo, publishTime };
}

export async function fetchVaultStateAccount(
  connection: Connection,
  programId: PublicKey,
  commitment: Commitment = 'processed',
): Promise<VaultStateAccount | null> {
  const address = deriveVaultStatePda(programId);
  const data = await fetchAccountBuffer(connection, address, commitment);
  if (!data) return null;
  return parseVaultStateAccount(data, address);
}

export async function fetchAllyAccount(
  connection: Connection,
  programId: PublicKey,
  allyMint: PublicKey,
  commitment: Commitment = 'processed',
): Promise<AllyAccountState | null> {
  const address = deriveAllyPda(programId, allyMint);
  const data = await fetchAccountBuffer(connection, address, commitment);
  if (!data) return null;
  return parseAllyAccount(data, address);
}

export async function fetchMockOracleSolAccount(
  connection: Connection,
  programId: PublicKey,
  commitment: Commitment = 'processed',
): Promise<MockOracleSolUsdAccount | null> {
  const address = deriveMockOracleSolPda(programId);
  const data = await fetchAccountBuffer(connection, address, commitment);
  if (!data) return null;
  return parseMockOracleSol(data, address);
}

export async function fetchMockPoolForcaAccount(
  connection: Connection,
  programId: PublicKey,
  commitment: Commitment = 'processed',
): Promise<MockPoolForcaSolAccount | null> {
  const address = deriveMockPoolForcaPda(programId);
  const data = await fetchAccountBuffer(connection, address, commitment);
  if (!data) return null;
  return parseMockPoolForca(data, address);
}

function encodeU64(value: bigint): Buffer {
  if (value < 0n) throw new Error('value must be unsigned');
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

export function createConvertToScopedPPIx(params: {
  programId: PublicKey;
  accounts: ConvertToScopedPPAccounts;
  amountForca: bigint;
  solPriceUsdE6: bigint;
  forcaPerSolE6: bigint;
}): TransactionInstruction {
  const { programId, accounts, amountForca, solPriceUsdE6, forcaPerSolE6 } = params;
  const data = Buffer.concat([
    IX_CONVERT_TO_SCOPED_PP_DISCRIMINATOR,
    encodeU64(amountForca),
    encodeU64(solPriceUsdE6),
    encodeU64(forcaPerSolE6),
  ]);

  const keys = [
    { pubkey: accounts.user, isSigner: true, isWritable: true },
    { pubkey: accounts.userAta, isSigner: false, isWritable: true },
    { pubkey: accounts.vaultState, isSigner: false, isWritable: false },
    { pubkey: accounts.ally, isSigner: false, isWritable: true },
    { pubkey: accounts.nftMint, isSigner: false, isWritable: false },
    { pubkey: accounts.allyVaultAta, isSigner: false, isWritable: true },
    { pubkey: accounts.userLedger, isSigner: false, isWritable: true },
    { pubkey: accounts.tokenProgram, isSigner: false, isWritable: false },
    { pubkey: accounts.systemProgram, isSigner: false, isWritable: false },
    { pubkey: accounts.pythSolUsdPriceFeed, isSigner: false, isWritable: false },
    { pubkey: accounts.canonicalPoolForcaSol, isSigner: false, isWritable: false },
    { pubkey: accounts.mockOracleSol, isSigner: false, isWritable: false },
    { pubkey: accounts.mockPoolForca, isSigner: false, isWritable: false },
    { pubkey: accounts.poolForcaReserve, isSigner: false, isWritable: false },
    { pubkey: accounts.poolSolReserve, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId, keys, data });
}

export function createClaimRPIx(params: {
  programId: PublicKey;
  accounts: ClaimRPAccounts;
  amountForca: bigint;
}): TransactionInstruction {
  const { programId, accounts, amountForca } = params;
  const data = Buffer.concat([
    IX_CLAIM_RP_DISCRIMINATOR,
    encodeU64(amountForca),
  ]);

  const keys = [
    { pubkey: accounts.user, isSigner: true, isWritable: true },
    { pubkey: accounts.userAta, isSigner: false, isWritable: true },
    { pubkey: accounts.ally, isSigner: false, isWritable: true },
    { pubkey: accounts.vaultState, isSigner: false, isWritable: false },
    { pubkey: accounts.vaultSigner, isSigner: false, isWritable: false },
    { pubkey: accounts.allyVaultAta, isSigner: false, isWritable: true },
    { pubkey: accounts.userLedger, isSigner: false, isWritable: true },
    { pubkey: accounts.tokenProgram, isSigner: false, isWritable: false },
    { pubkey: accounts.popProfile, isSigner: false, isWritable: true },
    { pubkey: accounts.claimGuard, isSigner: false, isWritable: true },
    { pubkey: accounts.pythSolUsdPriceFeed, isSigner: false, isWritable: false },
    { pubkey: accounts.canonicalPoolForcaSol, isSigner: false, isWritable: false },
    { pubkey: accounts.mockOracleSol, isSigner: false, isWritable: false },
    { pubkey: accounts.mockPoolForca, isSigner: false, isWritable: false },
    { pubkey: accounts.poolForcaReserve, isSigner: false, isWritable: false },
    { pubkey: accounts.poolSolReserve, isSigner: false, isWritable: false },
    { pubkey: accounts.systemProgram, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId, keys, data });
}
