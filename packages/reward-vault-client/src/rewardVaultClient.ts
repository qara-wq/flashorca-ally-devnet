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
  createdTs: number | null;
  updatedTs: number | null;
};

export type RewardVaultSnapshot = {
  popProfile: PopProfileData | null;
  ledgers: UserLedgerData[];
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
const USER_LEDGER_SIZE = 8 + 32 + 32 + 8 + 8 + 8 + 1 + 8 + 8;

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
  const levelLabel: PopLevelLabel = POP_LEVEL_LABELS[levelIndex] ?? 'Unknown';
  const lastSet = data.readBigInt64LE(8 + 32 + 1 + 1);
  const lastSetTs = lastSet > 0n ? Number(lastSet) * 1000 : null;
  return {
    address,
    levelIndex,
    levelLabel,
    lastSetTs,
  };
}

function parseUserLedger(data: Buffer, address: PublicKey, ally: AllyConfig): UserLedgerData {
  const base = 8 + 32 + 32;
  const rpOffset = base;
  const ppOffset = rpOffset + 8;
  const hwmOffset = ppOffset + 8;
  const taxHwmOffset = hwmOffset + 8;
  const bumpOffset = taxHwmOffset + 8;
  const createdOffset = bumpOffset + 1;
  const updatedOffset = createdOffset + 8;

  const rpClaimable = data.readBigUInt64LE(rpOffset);
  const ppBalance = data.readBigUInt64LE(ppOffset);
  const hwmClaimed = data.readBigUInt64LE(hwmOffset);
  const created = data.readBigInt64LE(createdOffset);
  const updated = data.readBigInt64LE(updatedOffset);
  return {
    address,
    ally,
    exists: true,
    rpClaimable,
    ppBalance,
    hwmClaimed,
    createdTs: created > 0n ? Number(created) * 1000 : null,
    updatedTs: updated > 0n ? Number(updated) * 1000 : null,
  };
}

function parseOptPubkey(data: Buffer, offset: number): PublicKey | null {
  const flag = data.readUInt8(offset);
  if (flag === 0) return null;
  return new PublicKey(data.subarray(offset + 1, offset + 1 + 32));
}

async function fetchAccountBuffer(
  connection: Connection,
  address: PublicKey,
  commitment: Commitment = 'processed',
) {
  const info = await connection.getAccountInfo(address, commitment);
  return info?.data ? ensureBuffer(info.data) : null;
}

export function formatAmount(value: bigint, decimals = 9, suffix?: string): string {
  const div = BigInt(10) ** BigInt(decimals);
  const whole = value / div;
  const frac = value % div;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  const base = fracStr.length > 0 ? `${whole}.${fracStr}` : `${whole}`;
  return suffix ? `${base} ${suffix}` : base;
}

export function formatTimestamp(ts: number | null): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString(undefined, { hour12: false });
}

export async function fetchRewardVaultSnapshot(
  connection: Connection,
  userPubkey: PublicKey | null | undefined,
  config: RewardVaultConfig,
  options: FetchRewardSnapshotOptions = {},
): Promise<RewardVaultSnapshot> {
  const commitment = options.commitment ?? 'processed';
  const popAddr = userPubkey ? derivePopProfilePda(config.programId, userPubkey) : null;
  const popAccount = popAddr ? await fetchAccountBuffer(connection, popAddr, commitment) : null;
  const popProfile = popAccount && popAddr ? parsePopProfile(popAccount, popAddr) : null;

  const ledgers: UserLedgerData[] = [];
  for (const ally of config.allies) {
    if (!userPubkey) {
      ledgers.push({
        address: PublicKey.default,
        ally,
        exists: false,
        rpClaimable: 0n,
        ppBalance: 0n,
        hwmClaimed: 0n,
        createdTs: null,
        updatedTs: null,
      });
      continue;
    }
    const ledgerAddr = deriveUserLedgerPda(config.programId, userPubkey, ally.mint);
    const ledger = await fetchAccountBuffer(connection, ledgerAddr, commitment);
    if (ledger) ledgers.push(parseUserLedger(ledger, ledgerAddr, ally));
    else
      ledgers.push({
        address: ledgerAddr,
        ally,
        exists: false,
        rpClaimable: 0n,
        ppBalance: 0n,
        hwmClaimed: 0n,
        createdTs: null,
        updatedTs: null,
      });
  }

  return { popProfile, ledgers };
}

export function deriveVaultStatePda(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([SEED_VAULT_STATE], programId);
  return pda;
}

export function deriveVaultSignerPda(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([SEED_VAULT_SIGNER], programId);
  return pda;
}

export function deriveAllyPda(programId: PublicKey, allyMint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([SEED_ALLY, allyMint.toBuffer()], programId);
  return pda;
}

export function deriveAllyVaultAtaPda(programId: PublicKey, allyMint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([SEED_ALLY_VAULT, allyMint.toBuffer()], programId);
  return pda;
}

export function derivePopProfilePda(programId: PublicKey, user: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([SEED_POP, user.toBuffer()], programId);
  return pda;
}

export function deriveUserLedgerPda(programId: PublicKey, user: PublicKey, allyMint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([SEED_USER_LEDGER, user.toBuffer(), allyMint.toBuffer()], programId);
  return pda;
}

export function deriveClaimGuardPda(programId: PublicKey, user: PublicKey, allyMint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([SEED_CLAIM_GUARD, user.toBuffer(), allyMint.toBuffer()], programId);
  return pda;
}

export function deriveMockOracleSolPda(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([SEED_MOCK_ORACLE_SOL], programId);
  return pda;
}

export function deriveMockPoolForcaPda(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([SEED_MOCK_POOL_FORCA], programId);
  return pda;
}

export type VaultStateAccount = {
  address: PublicKey;
  paused: boolean;
  verifyPrices: boolean;
  useMockOracle: boolean;
  forcaMint: PublicKey;
  mktOpTreasury: PublicKey;
  techOpTreasury: PublicKey;
  pythSolUsdPriceFeed: PublicKey;
  canonicalPoolForcaSol: PublicKey;
  forcaUsdE6: bigint;
  vaultSignerBump: number;
};

export type AllyAccountState = {
  address: PublicKey;
  nftMint: PublicKey;
  settlementAuthority: PublicKey;
  treasuryAta: PublicKey;
  vaultAta: PublicKey;
  role: number;
  balanceForca: bigint;
  rpReserved: bigint;
  benefitMode: number;
  benefitBps: number;
};

export type MockOracleSolUsdAccount = {
  address: PublicKey;
  solPriceUsdE6: bigint;
  updatedAt: number;
};

export type MockPoolForcaSolAccount = {
  address: PublicKey;
  forcaPerSolE6: bigint;
  updatedAt: number;
};

export type AnchorPriceMessage = {
  price: bigint;
  conf: bigint;
  expo: number;
  publishTime: bigint;
};

function parseVaultStateAccount(data: Buffer, address: PublicKey): VaultStateAccount | null {
  // Minimal parser tailored for current UI needs
  try {
    let off = 8; // discr
    const paused = data.readUInt8(off) === 1; off += 1;
    const verifyPrices = data.readUInt8(off) === 1; off += 1;
    const useMockOracle = data.readUInt8(off) === 1; off += 1;
    off += 5; // padding
    const readPubkey = () => new PublicKey(data.subarray(off, off += 32));
    const forcaMint = readPubkey();
    const mktOpTreasury = readPubkey();
    const techOpTreasury = readPubkey();
    const pythSolUsdPriceFeed = readPubkey();
    const canonicalPoolForcaSol = readPubkey();
    const forcaUsdE6 = data.readBigInt64LE(off); off += 8;
    const vaultSignerBump = data.readUInt8(off); // not moving off further
    return {
      address,
      paused,
      verifyPrices,
      useMockOracle,
      forcaMint,
      mktOpTreasury,
      techOpTreasury,
      pythSolUsdPriceFeed,
      canonicalPoolForcaSol,
      forcaUsdE6,
      vaultSignerBump,
    };
  } catch {
    return null as any;
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
    const readU16 = () => {
      const v = data.readUInt16LE(offset);
      offset += 2;
      return v;
    };
    const readU64 = () => {
      const v = data.readBigUInt64LE(offset);
      offset += 8;
      return v;
    };

    const nftMint = readPubkey();
    const settlementAuthority = readPubkey();
    const treasuryAta = readPubkey();
    const vaultAta = readPubkey();
    const role = readU8();
    const balanceForca = readU64();
    const rpReserved = readU64();
    const benefitMode = readU8();
    const benefitBps = readU16();

    return {
      address,
      nftMint,
      settlementAuthority,
      treasuryAta,
      vaultAta,
      role,
      balanceForca,
      rpReserved,
      benefitMode,
      benefitBps,
    };
  } catch {
    return null;
  }
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
  const price = data.readBigInt64LE(8);
  const updated = Number(data.readBigInt64LE(8 + 8)) * 1000;
  return { address, solPriceUsdE6: price, updatedAt: updated };
}

export async function fetchMockPoolForcaAccount(
  connection: Connection,
  programId: PublicKey,
  commitment: Commitment = 'processed',
): Promise<MockPoolForcaSolAccount | null> {
  const address = deriveMockPoolForcaPda(programId);
  const data = await fetchAccountBuffer(connection, address, commitment);
  if (!data) return null;
  const forcaPerSolE6 = data.readBigInt64LE(8);
  const updatedAt = Number(data.readBigInt64LE(8 + 8)) * 1000;
  return { address, forcaPerSolE6, updatedAt };
}

export function parseAnchorPriceMessageAccount(data: Buffer): AnchorPriceMessage | null {
  const need = 8 + 32 + 1 + 32 + 8 + 8 + 4 + 8;
  if (data.length < need) return null;
  let off = 8 + 32;
  const tag = data.readUInt8(off); off += 1;
  if (tag === 0) {
    if (off + 1 > data.length) return null;
    off += 1;
  } else if (tag !== 1) {
    return null;
  }
  if (off + 32 + 8 + 8 + 4 + 8 > data.length) return null;
  off += 32;
  const price = data.readBigInt64LE(off); off += 8;
  const conf = data.readBigUInt64LE(off); off += 8;
  const expo = data.readInt32LE(off); off += 4;
  const publishTime = data.readBigInt64LE(off);
  return { price, conf, expo, publishTime };
}

export function scalePriceToMicroUsd(price: bigint, expo: number): bigint | null {
  let v = price;
  const adj = expo + 6;
  try {
    if (adj > 0) {
      let f = 1n; for (let i = 0; i < adj; i++) f *= 10n; v *= f;
    } else if (adj < 0) {
      let f = 1n; for (let i = 0; i < -adj; i++) f *= 10n; v /= f;
    }
  } catch {
    return null;
  }
  if (v < 0) return null;
  return v;
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

function encodeU64(value: bigint): Buffer {
  if (value < 0n) throw new Error('value must be unsigned');
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

export type ConvertToScopedPPAccounts = {
  user: PublicKey;
  userAta: PublicKey;
  vaultState: PublicKey;
  ally: PublicKey;
  nftMint: PublicKey;
  allyVaultAta: PublicKey;
  mktOpTreasury: PublicKey;
  techOpTreasury: PublicKey;
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
    { pubkey: accounts.mktOpTreasury, isSigner: false, isWritable: true },
    { pubkey: accounts.techOpTreasury, isSigner: false, isWritable: true },
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

export type ClaimRPAccounts = {
  user: PublicKey;
  userAta: PublicKey;
  ally: PublicKey;
  vaultState: PublicKey;
  vaultSigner: PublicKey;
  allyVaultAta: PublicKey;
  mktOpTreasury: PublicKey;
  techOpTreasury: PublicKey;
  userLedger: PublicKey;
  tokenProgram: PublicKey;
  popProfile: PublicKey;
  claimGuard: PublicKey;
  systemProgram: PublicKey;
};

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
    { pubkey: accounts.mktOpTreasury, isSigner: false, isWritable: true },
    { pubkey: accounts.techOpTreasury, isSigner: false, isWritable: true },
    { pubkey: accounts.userLedger, isSigner: false, isWritable: true },
    { pubkey: accounts.tokenProgram, isSigner: false, isWritable: false },
    { pubkey: accounts.popProfile, isSigner: false, isWritable: true },
    { pubkey: accounts.claimGuard, isSigner: false, isWritable: true },
    { pubkey: accounts.systemProgram, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId, keys, data });
}
