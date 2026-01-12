import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { Connection, SystemProgram, Transaction, ComputeBudgetProgram, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from '@solana/web3.js';

import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from '@solana/spl-token';

import type { Adapter } from '@solana/wallet-adapter-base';
import type {
  SolanaSignInInput,
  SolanaSignInOutput,
} from '@solana/wallet-standard-features';

import { WalletMultiButton, useWalletModal } from '@solana/wallet-adapter-react-ui';
import {
  getRewardVaultConfig,
  fetchRewardVaultSnapshot,
  formatAmount,
  formatTimestamp,
  fetchVaultStateAccount,
  fetchAllyAccount,
  fetchMockOracleSolAccount,
  fetchMockPoolForcaAccount,
  deriveVaultSignerPda,
  deriveUserLedgerPda,
  derivePopProfilePda,
  deriveClaimGuardPda,
  deriveMockOracleSolPda,
  deriveMockPoolForcaPda,
  createConvertToScopedPPIx,
  createClaimRPIx,
  parseAnchorPriceMessageAccount,
  parsePythPriceAccount,
  scalePriceToMicroUsd,
} from './rewardVaultClient';
import type {
  RewardVaultSnapshot,
  VaultStateAccount,
  AllyAccountState,
  MockOracleSolUsdAccount,
  MockPoolForcaSolAccount,
  UserLedgerData,
} from './rewardVaultClient';

import { showOpenInWalletOverlay } from '@flashorca/wallet-browse';

declare global {
  interface Window {
    turnstile?: {
      render: (container: string | HTMLElement, options: Record<string, any>) => string;
      reset?: (widgetId?: string) => void;
      execute?: (widgetId?: string) => void;
    };
    __TURNSTILE_SITE_KEY__?: string;
  }
}

const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

// 시도 횟수별 tip 사다리(마이크로-람포츠/1 CU)
const tipFor = (attempt: number) => [100_000, 300_000, 1_000_000][attempt] ?? 300_000;
// 필요시 CU 상한도 명시(안전빵)
const CU_LIMIT = 1_000_000;
const FORCA_DECIMALS = 6;
const MICRO_SCALE = 1_000_000n;
const WSOL_SCALE = 1_000_000_000n;
const MAX_U64 = (1n << 64n) - 1n;

const REWARD_DROPDOWN_ANCHOR_CLASS = 'reward-dropdown-anchored';
const DROPDOWN_MARGIN = 6;
const DROPDOWN_HEIGHT = 280;

const anchorRewardDropdown = (rect?: DOMRect) => {
  if (!rect || typeof document === 'undefined') return;
  const html = document.documentElement;
  if (!html) return;
  const maxTop = Math.max(window.innerHeight - DROPDOWN_HEIGHT - DROPDOWN_MARGIN, DROPDOWN_MARGIN);
  const top = Math.min(Math.max(rect.bottom + DROPDOWN_MARGIN, DROPDOWN_MARGIN), maxTop);
  const centerX = Math.min(Math.max(rect.left + rect.width / 2, DROPDOWN_MARGIN), window.innerWidth - DROPDOWN_MARGIN);
  html.classList.add(REWARD_DROPDOWN_ANCHOR_CLASS);
  html.style.setProperty('--reward-dropdown-top', `${Math.round(top)}px`);
  html.style.setProperty('--reward-dropdown-left', `${Math.round(centerX)}px`);
};

const clearRewardDropdownAnchor = () => {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  if (!html) return;
  html.classList.remove(REWARD_DROPDOWN_ANCHOR_CLASS);
  html.style.removeProperty('--reward-dropdown-top');
  html.style.removeProperty('--reward-dropdown-left');
};

const RV_ERROR_MAP: Record<number, string> = {
  6000: 'Vault is paused',
  6001: 'Arithmetic overflow',
  6002: 'Invalid BPS parameter',
  6003: 'FORCA decimals mismatch',
  6004: 'Invalid mint account',
  6005: 'Insufficient ally balance',
  6006: 'Insufficient vault balance',
  6007: 'Insufficient unreserved balance',
  6008: 'Insufficient reserved balance',
  6009: 'Amount must be greater than zero',
  6010: 'Invalid quote parameters',
  6011: 'Insufficient claimable RP',
  6012: 'Insufficient PP balance',
  6013: 'Amount too small after fee',
  6014: 'Invalid treasury token account',
  6015: 'Invalid vault token account',
  6016: 'PoP level blocks this action',
  6017: 'Soft PoP daily cap exceeded',
  6018: 'Cooldown has not elapsed',
  6019: 'Soft PoP daily cap too low',
  6020: 'Soft PoP cooldown too high',
  6021: 'Invalid authority',
  6022: 'Oracle accounts missing',
  6023: 'Oracle values out of tolerance',
  6024: 'Oracle key mismatch',
  6025: 'Oracle parsing failed',
  6026: 'Oracle price stale',
  6027: 'Invalid benefit mode value',
  6028: 'verify_prices cannot be disabled once enabled',
  6029: 'Invalid pause reason code',
  6030: 'Manual FORCA/USD disabled unless mock oracle is enabled',
  6031: 'use_mock_oracle cannot be re-enabled once disabled',
  6032: 'Monthly claim limit exceeded',
  6033: 'KYC required for claim',
  6034: 'Monthly claim limit too low',
  6035: 'Monthly claim limit too high',
  6036: 'KYC threshold too low',
  6037: 'Oracle confidence interval too wide',
};

const formatMicroUsd = (value: bigint, fractionDigits = 2): string => {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / MICRO_SCALE;
  let fraction = (abs % MICRO_SCALE).toString().padStart(6, '0');
  if (fractionDigits < 6) fraction = fraction.slice(0, fractionDigits);
  fraction = fraction.replace(/0+$/, '');
  const body = fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
  return `${negative ? '-' : ''}$${body}`;
};

const formatBps = (bps: number): string => {
  const percent = (bps / 100).toFixed(2).replace(/\.?0+$/, '');
  return `${percent}% (${bps} bps)`;
};

const BENEFIT_MODE_LABELS: Record<number, string> = {
  0: 'None',
  1: 'Discount',
  2: 'Bonus PP',
};

const normalizePopLabel = (raw: string | undefined | null): string => {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return '';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
};

const getBenefitModeLabel = (mode: number): string => BENEFIT_MODE_LABELS[mode] ?? `Unknown (${mode})`;

// Available quests are provided by the backend (/api/quests/state.available)

const extractProgramLogs = (err: any): string[] | null => {
  if (!err) return null;
  if (Array.isArray(err.logs)) return err.logs;
  if (Array.isArray(err.data?.logs)) return err.data.logs;
  if (Array.isArray(err.originalError?.logs)) return err.originalError.logs;
  if (Array.isArray(err.originalError?.data?.logs)) return err.originalError.data.logs;
  if (err.cause) return extractProgramLogs(err.cause);
  return null;
};

const extractFriendlyError = (err: any): string => {
  if (!err) return 'Unexpected error';
  const logs = extractProgramLogs(err);
  if (logs && logs.length > 0) {
    for (const line of logs) {
      const anchorIdx = line.indexOf('Error Message:');
      if (anchorIdx >= 0) {
        return line.slice(anchorIdx + 'Error Message:'.length).trim();
      }
    }
    const customLine = logs.find((line) => line.toLowerCase().includes('custom program error:'));
    if (customLine) {
      const match = customLine.match(/custom program error:\s*(0x[a-f0-9]+)/i);
      if (match) {
        const code = Number.parseInt(match[1], 16);
        const friendly = RV_ERROR_MAP[code];
        if (friendly) return friendly;
        return `Program error 0x${code.toString(16)}`;
      }
    }
  }
  if (err.message) return err.message;
  return 'Unexpected error';
};

type UxLogLevel = 'info' | 'success' | 'error' | 'warning';
type UxLogEntry = { ts: number; level: UxLogLevel; message: string; source?: string };

type ContextDebugSection = { title?: string | null; text?: string | null; length?: number | null };
type ContextDebugPreview = {
  sections: ContextDebugSection[];
  augmented?: string | null;
  userQuestion?: string | null;
  ts?: string | null;
  clientContext?: Record<string, string>;
  pending?: boolean;
};

type AssistantMessage = { role: 'user' | 'bot'; text: string; html?: string };

const escapeHtml = (val: string): string =>
  val
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const renderAssistantMarkdown = (markdown: string): string => {
  if (!markdown) return '';
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let inCode = false;
  let codeLang = '';
  let codeLines: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const renderInline = (txt: string): string => {
    let html = escapeHtml(txt);
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    html = html.replace(/\*(?!\s)([^*]+?)\*(?!\*)/g, '<em>$1</em>');
    html = html.replace(/_(?!\s)([^_]+?)_(?!_)/g, '<em>$1</em>');
    return html;
  };

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const html = paragraph.map((line) => renderInline(line.trim())).join('<br />');
    if (html) blocks.push(`<p>${html}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!list) return;
    const tag = list.ordered ? 'ol' : 'ul';
    const items = list.items.map((item) => `<li>${renderInline(item.trim())}</li>`).join('');
    blocks.push(`<${tag}>${items}</${tag}>`);
    list = null;
  };

  const flushCode = () => {
    const content = escapeHtml(codeLines.join('\n'));
    const langAttr = codeLang ? ` data-lang="${escapeHtml(codeLang)}"` : '';
    blocks.push(`<pre${langAttr}><code>${content}</code></pre>`);
    codeLines = [];
    codeLang = '';
  };

  const closeTextBlocks = () => {
    flushParagraph();
    flushList();
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    const fenceMatch = line.match(/^```(.*)?$/);
    if (fenceMatch) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        closeTextBlocks();
        inCode = true;
        codeLang = (fenceMatch[1] || '').trim();
        codeLines = [];
      }
      continue;
    }

    if (inCode) {
      codeLines.push(rawLine);
      continue;
    }

    if (!line.trim()) {
      // Blank lines shouldn't break an active list; just add vertical breathing room.
      if (!list) closeTextBlocks();
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      closeTextBlocks();
      blocks.push('<hr />');
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      closeTextBlocks();
      const level = Math.min(headingMatch[1].length + 2, 5); // Keep headings compact in the chat bubble
      blocks.push(`<h${level}>${renderInline(headingMatch[2].trim())}</h${level}>`);
      continue;
    }

    const quoteMatch = line.match(/^\s*>\s?(.*)$/);
    if (quoteMatch) {
      closeTextBlocks();
      blocks.push(`<blockquote>${renderInline(quoteMatch[1])}</blockquote>`);
      continue;
    }

    const olMatch = line.match(/^\s*\d+\.\s+(.*)$/);
    const ulMatch = line.match(/^\s*[-*+]\s+(.*)$/);
    if (olMatch || ulMatch) {
      flushParagraph();
      const ordered = Boolean(olMatch);
      const itemText = (olMatch ? olMatch[1] : ulMatch?.[1] || '').trim();
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(itemText);
      continue;
    }

    // If a list was open and we hit a plain paragraph line, flush the list first.
    flushList();
    paragraph.push(line);
  }

  if (inCode) {
    flushCode();
  }
  closeTextBlocks();
  return blocks.join('');
};

const toAssistantMessage = (role: 'user' | 'bot', text: string): AssistantMessage =>
  role === 'bot' ? { role, text, html: renderAssistantMarkdown(text) } : { role, text };

const CHAT_WAITING_HINTS = [
  'Running a quick security check…',
  'Pulling your quest and vault context…',
  'Lining up RP → FORCA → PP steps…',
  'Drafting a concise reply…',
  'Checking for recent history updates…',
];

const UX_LOG_KEY = 'fo_ux_log_v1';
const UX_LOG_COOKIE = 'fo_ux_meta';
const UX_LOG_LIMIT = 50;
const CTX_CACHE_KEY = 'fo_ctx_cache_v1';
const isSnapshotRich = (text: string | null | undefined) =>
  !!text && /Ledger|PoP|Vault state|allyMint|FORCA Balance/i.test(text);

const readUxLogs = (): UxLogEntry[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(UX_LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((p) => ({
        ts: typeof p?.ts === 'number' ? p.ts : Date.now(),
        level: (p?.level as UxLogLevel) || 'info',
        message: String(p?.message ?? '').slice(0, 320),
        source: typeof p?.source === 'string' ? p.source : undefined,
      }))
      .filter((p) => p.message.length > 0);
  } catch {
    return [];
  }
};

const persistUxLogs = (entries: UxLogEntry[]) => {
  if (typeof window === 'undefined') return;
  const trimmed = entries.slice(-UX_LOG_LIMIT);
  try {
    window.localStorage.setItem(UX_LOG_KEY, JSON.stringify(trimmed));
  } catch { /* ignore */ }
  try {
    const last = trimmed[trimmed.length - 1];
    const meta = {
      c: trimmed.length,
      ts: last?.ts ?? Date.now(),
      last: (last?.message ?? '').slice(0, 80),
    };
    document.cookie = `${UX_LOG_COOKIE}=${encodeURIComponent(JSON.stringify(meta))}; path=/; max-age=900; SameSite=Lax`;
  } catch { /* ignore cookie issues */ }
};

const appendUxLogEntry = (entry: Omit<UxLogEntry, 'ts'> & { ts?: number }) => {
  if (typeof window === 'undefined') return;
  const next: UxLogEntry[] = [...readUxLogs(), {
    ts: entry.ts ?? Date.now(),
    level: entry.level ?? 'info',
    message: String(entry.message ?? '').slice(0, 320),
    source: entry.source,
  }];
  persistUxLogs(next);
};

const clearUxLogsStorage = () => {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(UX_LOG_KEY); } catch { /* ignore */ }
  try { document.cookie = `${UX_LOG_COOKIE}=; Max-Age=0; path=/; SameSite=Lax`; } catch { /* ignore */ }
};

// HTTP-only confirmation (no WebSocket). Avoids ws://localhost:5174/rpc errors when using HTTP proxy.
async function waitForConfirmationPoll(
  connection: Connection,
  sig: string,
  lastValidBlockHeight?: number,
  timeoutMs = 60_000,
  intervalMs = 1_000
) {
  const started = Date.now();
  for (; ;) {
    // 1) 상태 조회 (HTTP)
    const { value } = await connection.getSignatureStatuses([sig]);
    const st = value[0]; // null이면 아직 RPC가 못봄 → 계속 대기

    if (st?.err) throw new Error(`Transaction error: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return st;

    // 2) blockhash 만료 감지
    if (lastValidBlockHeight) {
      const h = await connection.getBlockHeight('processed');
      if (h > lastValidBlockHeight) {
        throw new Error('Blockhash expired before confirmation');
      }
    }

    // 3) 타임아웃/백오프
    if (Date.now() - started > timeoutMs) throw new Error('Timeout waiting for confirmation');
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

type SignInCapable = Adapter & {
  signIn: (input?: SolanaSignInInput) => Promise<SolanaSignInOutput>;
};

function hasSignIn(a: Adapter | undefined): a is SignInCapable {
  return !!a && 'signIn' in a && typeof (a as any).signIn === 'function';
}

type AllyActionState = {
  convertAmount: string;
  convertStatus: 'idle' | 'pending' | 'success' | 'error';
  convertMessage: string | null;
  convertTxSig?: string | null;
  claimAmount: string;
  claimStatus: 'idle' | 'pending' | 'success' | 'error';
  claimMessage: string | null;
  claimTxSig?: string | null;
  convertDebug?: string[];
  claimDebug?: string[];
};

const createDefaultActionState = (): AllyActionState => ({
  convertAmount: '',
  convertStatus: 'idle',
  convertMessage: null,
  convertTxSig: null,
  claimAmount: '',
  claimStatus: 'idle',
  claimMessage: null,
  claimTxSig: null,
  convertDebug: [],
  claimDebug: [],
});

async function signAndSendWithRebroadcast(
  connection: Connection,
  adapter: Adapter,
  tx: Transaction,
  rebroadcastMs = 400
): Promise<{ sig: string; stop: () => void }> {
  // Sign and serialize
  // @ts-ignore - most adapters implement signTransaction
  const signed = await (adapter as any).signTransaction(tx);
  const raw = signed.serialize();

  // First send
  let sig = await connection.sendRawTransaction(raw, {
    skipPreflight: true,
    // preflight can burn precious time; we rely on blockhash-expiry guard instead
    maxRetries: 0,
  });

  // Keep re-sending the identical bytes to multiple leaders via the same RPC
  // (idempotent; returns same signature). This greatly reduces "st === null" stalls.
  const timer = setInterval(() => {
    connection
      .sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })
      .catch(() => { });
  }, rebroadcastMs);

  return { sig, stop: () => clearInterval(timer) };
}


export default function App() {
  const features = (window as any).__FEATURE_FLAGS__ ?? {};
  const rewardVaultOnly = Boolean(features.rewardVaultOnly);

  // Use the same Connection instance provided by Wallet Adapter.
  // This prevents endpoint mismatches between the provider and our app code.
  const { connection } = useConnection();

  const { connected, publicKey, connect, disconnect, sendTransaction, signMessage, wallet } = useWallet();
  const { setVisible: setWalletModalVisible } = useWalletModal();

  // Open in Wallet UI는 공통 패키지의 오버레이를 사용

  const [sol, setSol] = useState<number | null>(null);
  const [spl, setSpl] = useState<Array<{
    mint: string;
    uiAmount: number;
    uiAmountString: string;
    decimals: number;
  }>>([]);
  const rewardVaultConfig = useMemo(() => getRewardVaultConfig(), []);
  const [rewardSnapshot, setRewardSnapshot] = useState<RewardVaultSnapshot | null>(null);
  const [rewardLoading, setRewardLoading] = useState(false);
  const [rewardError, setRewardError] = useState<string | null>(null);
  const [vaultStateAccount, setVaultStateAccount] = useState<VaultStateAccount | null>(null);
  const [allyAccountMap, setAllyAccountMap] = useState<Record<string, AllyAccountState | null>>({});
  const [mockOracleAccount, setMockOracleAccount] = useState<MockOracleSolUsdAccount | null>(null);
  const [mockPoolAccount, setMockPoolAccount] = useState<MockPoolForcaSolAccount | null>(null);
  const [actionState, setActionState] = useState<Record<string, AllyActionState>>({});
  const [snapshotReloadNonce, setSnapshotReloadNonce] = useState(0);
  const [snapshotFocus, setSnapshotFocus] = useState<{ allyMint: string; action: 'claim' | 'convert' } | null>(null);
  const snapshotFocusTimeoutRef = useRef<number | null>(null);
  const snapshotActionRefs = useRef<Record<string, { claim?: HTMLDivElement | null; convert?: HTMLDivElement | null }>>({});
  const snapshotFetchedAtRef = useRef<number | null>(null);
  const lastWalletFetchRef = useRef<number>(0);
  const lastQuoteFetchRef = useRef<number>(0);
  const [quoteInfo, setQuoteInfo] = useState<{
    solPriceUsdE6: bigint;
    forcaPerSolE6: bigint;
    forcaUsdE6: bigint;
    updatedAt: number;
  } | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const rewardProgramId = rewardVaultConfig.programId.toBase58();
  const forcaMint = useMemo(() => {
    const raw = (import.meta.env.VITE_FORCA_MINT ?? '').toString().trim();
    if (raw) return raw;
    return 'J1wsY5rqFesHmQojnzBNs4Bhk5vEtCb9GU5xv7A7pump';
  }, []);
  const forcaTokenBalance = useMemo(() => {
    if (!forcaMint) return null;
    return spl.find((t) => t.mint === forcaMint) ?? null;
  }, [spl, forcaMint]);

  const showDebug = features.debugTabs ?? true;
  const showBalanceAll = features.balanceAll ?? true;
  const showSIWS = features.SIWS ?? true;
  const showTopUI = features.TopUI ?? true;
  const showContextHelper = import.meta.env.DEV;
  const [serverRpcIsDevnet, setServerRpcIsDevnet] = useState(false);

  useEffect(() => {
    fetch('/api/env')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        const rpcUrl = typeof data.rpc_url === 'string' ? data.rpc_url : '';
        const hint = typeof data.is_devnet === 'boolean' ? data.is_devnet : rpcUrl.toLowerCase().includes('devnet');
        setServerRpcIsDevnet(Boolean(hint));
      })
      .catch(() => { });
  }, []);

  // ---- Unified auth/session ----
  type Quest = {
    quest_id: string;
    status: string;
    accepted_at: string;
    last_updated_at: string;
    meta?: any;
    reward_tx_sig?: string | null;
    reward_forca_e6?: number | string | null;
    rewarded_at?: string | null;
  };
  type AvailableQuest = { quest_id: string; title: string; reward_rp?: number; reward_pop?: string; reward_label?: string };
  type QuestStatePayload = { quests: Quest[]; available: AvailableQuest[]; defs: Record<string, any>; official: { x_handle: string; x_user_id?: string | null } };
  type QuestRewardState = { status: 'idle' | 'pending' | 'success' | 'error'; message?: string | null; tx?: string | null };
  const [jwtToken, setJwtToken] = useState<string | null>(null);
  const [currentTab, setCurrentTab] = useState<'assistant' | 'quests' | 'shop' | 'snapshot' | 'history'>(() => (
    rewardVaultOnly ? 'snapshot' : 'assistant'
  ));
  const snapshotTabActive = currentTab === 'snapshot';
  const walletDataVisible = currentTab === 'assistant' || currentTab === 'snapshot' || currentTab === 'shop';
  useEffect(() => {
    if (rewardVaultOnly && currentTab !== 'snapshot') {
      setCurrentTab('snapshot');
    }
  }, [rewardVaultOnly, currentTab]);
  // Limit on-chain RPC use to tabs that actually need reward snapshot/infra data.
  const rewardSnapshotQueriesEnabled =
    connected &&
    (
      currentTab === 'snapshot'
      || currentTab === 'shop'
      // Value Loop(assistant 상단) 최초 노출 시 한 번만 불러 최신 값 채움
      || (currentTab === 'assistant' && !rewardSnapshot)
    );
  const rewardInfraQueriesEnabled = connected && snapshotTabActive;
  const [quests, setQuests] = useState<Quest[]>([]);
  const questsRef = useRef<Quest[]>([]);
  const [questDefs, setQuestDefs] = useState<Record<string, any>>({});
  const [official, setOfficial] = useState<{ x_handle: string; x_user_id?: string | null } | null>(null);
  const [availableQuests, setAvailableQuests] = useState<AvailableQuest[]>([]);
  const [questAccepting, setQuestAccepting] = useState<string | null>(null);
  const [recentlyAcceptedQuestId, setRecentlyAcceptedQuestId] = useState<string | null>(null);
  const [questRewardStates, setQuestRewardStates] = useState<Record<string, QuestRewardState>>({});
  const questCardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const questHighlightTimeoutRef = useRef<number | null>(null);
  const quest1Meta = useMemo(() => {
    const q1 = quests.find((q) => q.quest_id === 'quest1_x_link');
    return q1?.meta || null;
  }, [quests]);
  const questTelegramMeta = useMemo(() => {
    const q = quests.find((quest) => quest.quest_id === 'quest1_telegram_link');
    return q?.meta || null;
  }, [quests]);
  const quest4Doc = useMemo(() => quests.find((quest) => quest.quest_id === 'quest4_pop_uniq') || null, [quests]);
  const [xOauthPending, setXOauthPending] = useState(false);
  const [xOauthStatus, setXOauthStatus] = useState<string | null>(null);
  const xOauthWinRef = useRef<Window | null>(null);
  const xOauthTimerRef = useRef<number | null>(null);
  const xOauthClosePollRef = useRef<number | null>(null);
  const xOauthStateRef = useRef<string | null>(null);
  const [telegramPending, setTelegramPending] = useState(false);
  const [telegramStatus, setTelegramStatus] = useState<string | null>(null);
  const telegramScriptPromiseRef = useRef<Promise<any> | null>(null);
  const defaultXScope = useMemo(() => (import.meta.env.VITE_X_OAUTH_SCOPE ?? 'tweet.read users.read offline.access').toString(), []);
  const [assistantMessages, setAssistantMessages] = useState<AssistantMessage[]>([
    toAssistantMessage('bot', 'Hello! I can help you claim RP, convert PP, and manage quests. I only request wallet approval when needed.'),
  ]);
  const appendAssistantMessage = useCallback(
    (role: AssistantMessage['role'], text: string) => {
      setAssistantMessages((prev) => [...prev, toAssistantMessage(role, text)]);
    },
    []
  );
  const [chatQuota, setChatQuota] = useState<{ remaining: number; initial: number; purchase_url?: string } | null>(null);
  const [chatSending, setChatSending] = useState(false);
  const [chatWaitHintIdx, setChatWaitHintIdx] = useState(0);
  const chatWaitHint = CHAT_WAITING_HINTS[chatWaitHintIdx] || CHAT_WAITING_HINTS[0];
  const chatWaitHintsCount = CHAT_WAITING_HINTS.length;
  useEffect(() => {
    if (!chatSending) {
      setChatWaitHintIdx(0);
      return;
    }
    const id = window.setInterval(() => {
      setChatWaitHintIdx((i) => (i + 1) % chatWaitHintsCount);
    }, 2000);
    return () => window.clearInterval(id);
  }, [chatSending, chatWaitHintsCount]);
  const [contextPeekEnabled, setContextPeekEnabled] = useState(false);
  const [contextPeekOpen, setContextPeekOpen] = useState(false);
  const [contextPreview, setContextPreview] = useState<ContextDebugPreview | null>(null);
  const contextPeekActive = showContextHelper && contextPeekEnabled;
  const turnstileSiteKey = useMemo(() => {
    const envKey = (import.meta.env.VITE_TURNSTILE_SITE_KEY || '').toString().trim();
    const winKey = typeof window !== 'undefined' ? (window.__TURNSTILE_SITE_KEY__ || '') : '';
    return envKey || winKey;
  }, []);
  const turnstileEnabled = turnstileSiteKey.length > 0;
  const TURNSTILE_PASS_KEY = 'fo_turnstile_pass_v1';
  const TURNSTILE_PASS_MS = 45 * 60 * 1000;
  const turnstileElRef = useRef<HTMLDivElement | null>(null);
  const turnstileWidgetIdRef = useRef<string | null>(null);
  const turnstileScriptPromiseRef = useRef<Promise<void> | null>(null);
  const turnstileRenderPromiseRef = useRef<Promise<void> | null>(null);
  const [, setTurnstileToken] = useState<string | null>(null);
  const [, setTurnstileError] = useState<string | null>(null);
  const turnstileWaitersRef = useRef<Array<(token: string | null) => void>>([]);
  const turnstilePassRef = useRef<{ exp: number; addr?: string } | null>(null);
  const ctxCacheRef = useRef<{ quests?: string; snapshot?: string; shop?: string }>({});
  const snapshotContextRef = useRef<string | null>(null);
  const loadCtxCache = useCallback(() => {
    if (ctxCacheRef.current && Object.keys(ctxCacheRef.current).length > 0) return ctxCacheRef.current;
    try {
      const raw = localStorage.getItem(CTX_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          ctxCacheRef.current = parsed;
          return parsed;
        }
      }
    } catch { /* ignore */ }
    return ctxCacheRef.current;
  }, []);
  const setCtxCache = useCallback((key: 'quests' | 'snapshot' | 'shop', value: string, opts?: { allowShallow?: boolean }) => {
    if (!value) return;
    if (key === 'snapshot' && !opts?.allowShallow && !isSnapshotRich(value)) return;
    const next = { ...ctxCacheRef.current, [key]: value };
    ctxCacheRef.current = next;
    try { localStorage.setItem(CTX_CACHE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }, []);
  const loadTurnstilePass = useCallback((addrHint?: string) => {
    if (turnstilePassRef.current && turnstilePassRef.current.exp > Date.now()) {
      if (!turnstilePassRef.current.addr || !addrHint || turnstilePassRef.current.addr === addrHint) {
        return turnstilePassRef.current;
      }
    }
    try {
      const raw = localStorage.getItem(TURNSTILE_PASS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.exp === 'number' && parsed.exp > Date.now()) {
        if (!parsed.addr || !addrHint || parsed.addr === addrHint) {
          turnstilePassRef.current = { exp: parsed.exp, addr: parsed.addr };
          return turnstilePassRef.current;
        }
      }
    } catch { /* ignore */ }
    return null;
  }, []);
  const storeTurnstilePass = useCallback((addrHint?: string) => {
    const exp = Date.now() + TURNSTILE_PASS_MS;
    const entry = { exp, addr: addrHint };
    turnstilePassRef.current = entry;
    try { localStorage.setItem(TURNSTILE_PASS_KEY, JSON.stringify(entry)); } catch { /* ignore */ }
  }, []);
  const clearTurnstilePass = useCallback(() => {
    turnstilePassRef.current = null;
    try { localStorage.removeItem(TURNSTILE_PASS_KEY); } catch { /* ignore */ }
  }, []);
  // Shop states
  const [donateAmount, setDonateAmount] = useState<string>("");
  const [donateNote, setDonateNote] = useState<string>("");
  const [donateBusy, setDonateBusy] = useState<boolean>(false);
  type TxMessage = { text: string; tx?: string | null };
  const [donateMsg, setDonateMsg] = useState<TxMessage | null>(null);
  const [chatBuyBusy, setChatBuyBusy] = useState<boolean>(false);
  const [chatBuyMsg, setChatBuyMsg] = useState<TxMessage | null>(null);

  type ChatHistoryItem = { role: 'user' | 'ai'; text: string; ts: string };
  type TimelineEntry = {
    id: string;
    source: 'pumpswap' | 'reward_vault' | 'shop' | 'quest' | string;
    ts?: string | null;
    ts_epoch?: number | null;
    title?: string | null;
    subtitle?: string | null;
    status?: string | null;
    amount_label?: string | null;
    txid?: string | null;
    slot?: number | null;
    program_id?: string | null;
  };
  const historySourceLabels: Record<string, string> = {
    quest: 'Quest',
    shop: 'Shop',
    reward_vault: 'Reward Vault',
    pumpswap: 'PumpSwap',
  };
  const historySourceOrder: Array<keyof typeof historySourceLabels> = ['quest', 'shop', 'reward_vault', 'pumpswap'];
  const [historyItems, setHistoryItems] = useState<ChatHistoryItem[]>([]);
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyAvailable, setHistoryAvailable] = useState<boolean | null>(null);
  const [historyCount, setHistoryCount] = useState<number>(0);
  const [timelineEntries, setTimelineEntries] = useState<TimelineEntry[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [timelineCounts, setTimelineCounts] = useState<Record<string, number>>({});
  const [timelineCursor, setTimelineCursor] = useState<string | null>(null);
  const [timelineHasMore, setTimelineHasMore] = useState(false);
  const [timelineFilters, setTimelineFilters] = useState<Array<keyof typeof historySourceLabels>>(historySourceOrder);
  const QUOTA_REFRESH_INTERVAL_MS = 30_000;
  const HISTORY_META_REFRESH_INTERVAL_MS = 60_000;
  const WALLET_FETCH_COOLDOWN_MS = 4_500;
  const lastQuotaFetchRef = useRef(0);
  const lastHistoryMetaFetchRef = useRef(0);
  const lastTimelineFetchRef = useRef(0);
  const timelineRequestIdRef = useRef(0);
  const timelineCursorRef = useRef<string | null>(null);
  const timelineLoadingRef = useRef(false);
  type ToastType = 'info' | 'success' | 'error' | 'warning';
  const [toasts, setToasts] = useState<Array<{ id: number; title?: string; message: string; type: ToastType }>>([]);
  const toastIdRef = useRef(0);
  const [shopItems, setShopItems] = useState<Array<{ id: string; kind: string; title: string; description?: string; price?: any }>>([]);
  const logUx = useCallback((message: string, opts?: { level?: UxLogLevel; source?: string }) => {
    appendUxLogEntry({
      message,
      level: opts?.level ?? 'info',
      source: opts?.source,
    });
  }, []);
  const pushToast = useCallback((message: string, opts?: { type?: ToastType; title?: string; durationMs?: number; sticky?: boolean; source?: string }) => {
    const type = opts?.type ?? 'info';
    const id = ++toastIdRef.current;
    const entry = { id, title: opts?.title, message, type };
    setToasts((prev) => [...prev.slice(-3), entry]);
    logUx(`${opts?.title ? `${opts.title} - ` : ''}${message}`, {
      level: type === 'error' ? 'error' : type === 'success' ? 'success' : type === 'warning' ? 'warning' : 'info',
      source: opts?.source || 'toast',
    });
    const duration = opts?.durationMs ?? 4400;
    if (!opts?.sticky && typeof window !== 'undefined') {
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, duration);
    }
  }, [logUx]);
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
  const toastIcons: Record<ToastType, string> = {
    success: '✔',
    error: '⛔',
    warning: '⚠️',
    info: 'ℹ️',
  };
  const formatDateTime = useCallback((ts?: string | null) => {
    if (!ts) return null;
    let s = ts;
    // 일부 문자열은 "+00:00Z"처럼 중복된 TZ가 붙어있어 Date 파싱이 깨질 수 있음 → trailing Z 제거
    if (s.includes('+') && s.endsWith('Z')) {
      s = s.slice(0, -1);
    }
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString(undefined, { hour12: false });
  }, []);

  const ensureTurnstileScript = useCallback(async () => {
    if (!turnstileEnabled) return;
    if (typeof window === 'undefined') return;
    if (window.turnstile) return;
    if (turnstileScriptPromiseRef.current) return turnstileScriptPromiseRef.current;

    turnstileScriptPromiseRef.current = new Promise<void>((resolve, reject) => {
      const handleError = () => {
        turnstileScriptPromiseRef.current = null;
        reject(new Error('Turnstile script load failed'));
      };
      const existing = document.querySelector(`script[src="${TURNSTILE_SCRIPT_SRC}"]`) as HTMLScriptElement | null;
      if (existing) {
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', handleError);
        return;
      }
      const s = document.createElement('script');
      s.src = TURNSTILE_SCRIPT_SRC;
      s.async = true;
      s.defer = true;
      s.dataset.cfTurnstile = '1';
      s.onload = () => resolve();
      s.onerror = handleError;
      document.head.appendChild(s);
    });

    return turnstileScriptPromiseRef.current;
  }, [turnstileEnabled]);

  const renderTurnstile = useCallback(async () => {
    if (!turnstileEnabled) return;
    if (!turnstileElRef.current) return;
    if (turnstileWidgetIdRef.current && window.turnstile) return;
    if (turnstileRenderPromiseRef.current) {
      await turnstileRenderPromiseRef.current;
      return;
    }
    turnstileRenderPromiseRef.current = (async () => {
      try {
        await ensureTurnstileScript();
      } catch (e: any) {
        setTurnstileError(e?.message || 'Failed to load Turnstile.');
        throw e;
      }
      if (!window.turnstile) {
        setTurnstileError('Turnstile initialization failed.');
        return;
      }
      setTurnstileError(null);
      try {
        const id = window.turnstile.render(turnstileElRef.current as HTMLElement, {
          sitekey: turnstileSiteKey,
          size: 'invisible',
          callback: (token: string) => {
            setTurnstileToken(token);
            turnstileWaitersRef.current.forEach((fn) => fn(token));
            turnstileWaitersRef.current = [];
          },
          'expired-callback': () => {
            setTurnstileToken(null);
          },
          'error-callback': () => {
            setTurnstileToken(null);
          },
          theme: 'dark',
        });
        turnstileWidgetIdRef.current = id;
      } catch (e: any) {
        setTurnstileError('Could not load the security widget. Please refresh and try again.');
        throw e;
      }
    })();
    await turnstileRenderPromiseRef.current.finally(() => {
      turnstileRenderPromiseRef.current = null;
    });
  }, [ensureTurnstileScript, turnstileEnabled, turnstileSiteKey]);

  const resetTurnstile = useCallback(() => {
    setTurnstileToken(null);
    try {
      if (turnstileWidgetIdRef.current && window.turnstile?.reset) {
        window.turnstile.reset(turnstileWidgetIdRef.current);
      }
    } catch { /* no-op */ }
  }, []);

  const ensureTurnstileToken = useCallback(async (): Promise<string | null> => {
    if (!turnstileEnabled) return null;
    await renderTurnstile();
    // 항상 새 토큰을 받도록 리셋 후 실행
    resetTurnstile();
    const widgetId = turnstileWidgetIdRef.current;
    const turnstile = window.turnstile;
    const executeTurnstile = turnstile?.execute;
    if (!widgetId || !turnstile || !executeTurnstile) {
      throw new Error('Turnstile not ready');
    }
    const tokenPromise = new Promise<string | null>((resolve, reject) => {
      let timeoutId: number;
      const resolver = (tok: string | null) => {
        window.clearTimeout(timeoutId);
        resolve(tok);
      };
      timeoutId = window.setTimeout(() => {
        turnstileWaitersRef.current = turnstileWaitersRef.current.filter((fn) => fn !== resolver);
        reject(new Error('Turnstile timed out'));
      }, 8000) as unknown as number;
      turnstileWaitersRef.current.push(resolver);
      try {
        // execute는 1개만 동작하도록 이미 렌더링한 동일 id로 호출
        executeTurnstile(widgetId);
      } catch (e) {
        window.clearTimeout(timeoutId);
        turnstileWaitersRef.current = turnstileWaitersRef.current.filter((fn) => fn !== resolver);
        reject(e);
      }
    });
    const tok = await tokenPromise;
    if (!tok) throw new Error('Turnstile returned empty token');
    return tok;
  }, [renderTurnstile, resetTurnstile, turnstileEnabled]);

  useEffect(() => {
    if (currentTab === 'assistant' && turnstileEnabled) {
      renderTurnstile().catch(() => { });
    }
  }, [currentTab, renderTurnstile, turnstileEnabled]);

  // --- Debug: expose UA and referrer for in-app detection troubleshooting ---
  const [ua, setUa] = useState<string>(navigator.userAgent);
  const [referrer, setReferrer] = useState<string>(document.referrer || '');
  useEffect(() => {
    const refresh = () => {
      try {
        setUa(navigator.userAgent);
        setReferrer(document.referrer || '');
      } catch { }
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  // --- Bridge to host page (FlashOrca Jinja/HTML) ---
  useEffect(() => {
    (window as any).flashorcaWallet = {
      open: () => setWalletModalVisible(true),

      connect: async () => {
        // 아직 지갑을 고르지 않았다면 모달만 열고 종료
        if (!wallet) {
          setWalletModalVisible(true);
          return;
        }
        try {
          if (!connected) {
            await connect();
          }
        } catch (e: any) {
          if (!e || e.name !== 'WalletNotSelectedError') {
            console.warn('connect() failed:', e);
          }
        }
      },
    };

    try { window.dispatchEvent(new Event('flashorca-wallet-ready')); } catch { }
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'mwa-ready' }, '*');
      }
    } catch { }
    // ✅ wallet 도 의존성에 포함 (선택 변경 시 최신 클로저 유지)
  }, [wallet, connected, connect, setWalletModalVisible]);

  // Listen for host commands (useful when embedded via <iframe> or script bridge)
  // useEffect(() => {
  //   const onMsg = (e: MessageEvent) => {
  //     const d = e.data;
  //     if (!d) return;
  //     if (d === 'open-wallet' || (typeof d === 'object' && d.type === 'open-wallet')) {
  //       setWalletModalVisible(true);
  //     } else if (d === 'connect-wallet' || (typeof d === 'object' && d.type === 'connect-wallet')) {
  //       (window as any).flashorcaWallet?.connect?.();
  //     }
  //   };
  //   window.addEventListener('message', onMsg);
  //   return () => window.removeEventListener('message', onMsg);
  // }, [setWalletModalVisible]);

  // useEffect(() => {
  //   if (wallet && !connected && !connecting) {
  //     connect().catch((e) => console.warn('auto-connect failed:', e));
  //   }
  // }, [wallet, connected, connecting, connect]);

  // 연결 상태 전이 감지: true -> false 시에만 disconnect 처리
  const prevConnectedRef = useRef<boolean>(false);
  useEffect(() => {
    const prev = prevConnectedRef.current;
    if (connected && !prev) {
      // just connected
      setWalletModalVisible(false);
      try {
        window.dispatchEvent(new CustomEvent('flashorca-wallet-connected', {
          detail: { address: publicKey?.toBase58() || null }
        }));
      } catch { }
    } else if (!connected && prev) {
      // transitioned to disconnected (not on initial mount)
      try { window.dispatchEvent(new Event('flashorca-wallet-disconnected')); } catch { }
      // 서버 세션 정리 + JWT 제거
      try { fetch('/api/logout', { method: 'POST', credentials: 'include' }); } catch {}
      persistJwt(null);
    }
    prevConnectedRef.current = connected;
  }, [connected, publicKey?.toBase58(), setWalletModalVisible]);

  // const handleConnect = async () => { if (!connected) await connect(); };

  // --- JWT 만료 임박 자동 재교환 ---
  const jwtRefreshTimerRef = useRef<number | null>(null);
  const exchangeJwtRef = useRef<(() => Promise<string | null>) | null>(null);
  const clearJwtRefreshTimer = useCallback(() => {
    if (jwtRefreshTimerRef.current) {
      window.clearTimeout(jwtRefreshTimerRef.current);
      jwtRefreshTimerRef.current = null;
    }
  }, []);
  const parseJwtExp = useCallback((t: string): number | null => {
    try {
      const base = t.split('.')[1]; if (!base) return null;
      const json = atob(base.replace(/-/g, '+').replace(/_/g, '/'));
      const payload = JSON.parse(json);
      return typeof payload.exp === 'number' ? payload.exp : null;
    } catch { return null; }
  }, []);
  const scheduleJwtRefresh = useCallback((t: string) => {
    clearJwtRefreshTimer();
    const exp = parseJwtExp(t); if (!exp) return;
    const leadMs = 5 * 60 * 1000; // 만료 5분 전
    const msUntil = exp * 1000 - Date.now() - leadMs;
    if (msUntil <= 0) { void exchangeJwtRef.current?.(); return; }
    jwtRefreshTimerRef.current = window.setTimeout(() => {
      const trigger = exchangeJwtRef.current;
      void trigger?.();
    }, msUntil) as unknown as number;
  }, [clearJwtRefreshTimer, parseJwtExp]);

  

  // 초기 로드: 로컬 저장소에서 불러온 후 서버에 유효성 확인
  useEffect(() => {
    (async () => {
      let t: string | null = null;
      try { t = localStorage.getItem('fo_jwt'); } catch {}
      if (t) {
        try {
          const ok = await fetch('/verify_token', { headers: { Authorization: `Bearer ${t}` } }).then(r => r.ok);
          if (ok) { persistJwt(t); scheduleJwtRefresh(t); } else { try { localStorage.removeItem('fo_jwt'); } catch {}; persistJwt(null); }
        } catch { try { localStorage.removeItem('fo_jwt'); } catch {}; setJwtToken(null); }
      } else {
        persistJwt(null);
      }
    })();
  }, []);

  const persistJwt = useCallback((t: string | null) => {
    setJwtToken(t);
    try {
      if (t) localStorage.setItem('fo_jwt', t);
      else localStorage.removeItem('fo_jwt');
    } catch {}
    // 호스트 페이지(renew_flashorca_index.html)와 UI 동기화
    try { window.dispatchEvent(new CustomEvent('flashorca-auth-changed', { detail: { jwt: t } })); } catch {}
    if (!t) clearJwtRefreshTimer();
  }, [clearJwtRefreshTimer]);

  const exchangeJwt = useCallback(async (): Promise<string | null> => {
    try {
      const j = await fetch('/api/auth/exchange_jwt', { credentials: 'include' }).then(r => r.ok ? r.json() : null);
      if (j?.access_token) {
        persistJwt(j.access_token);
        scheduleJwtRefresh(j.access_token);
        return j.access_token as string;
      }
      return null;
    } catch { return null; }
  }, [persistJwt, scheduleJwtRefresh]);

  useEffect(() => {
    exchangeJwtRef.current = exchangeJwt;
  }, [exchangeJwt]);

  useEffect(() => {
    if (!contextPeekEnabled || !showContextHelper) {
      setContextPreview(null);
      setContextPeekOpen(false);
    }
  }, [contextPeekEnabled, showContextHelper]);

  const ensureJwt = useCallback(async (): Promise<string | null> => {
    if (jwtToken) return jwtToken;
    // Try exchanging from current session (SIWS/legacy)
    const t = await exchangeJwt();
    if (t) return t;
    pushToast('Please sign in with the button above to use the AI Assistant.', { type: 'warning', title: 'Sign-in required', source: 'auth' });
    return null;
  }, [exchangeJwt, jwtToken, pushToast]);

  const refreshHistoryMeta = useCallback(async () => {
    const tok = await ensureJwt();
    if (!tok) return;
    try {
      const meta = await fetch('/chat_history/meta?with_total=1', {
        headers: { Authorization: `Bearer ${tok}` },
      }).then((r) => (r.ok ? r.json() : null));
      if (meta) {
        setHistoryAvailable(!!meta.has_history);
        setHistoryCount(typeof meta.total === 'number' ? meta.total : (meta.has_history ? Math.max(1, historyCount) : 0));
      }
    } catch {
      // ignore; keep previous values
    } finally {
      lastHistoryMetaFetchRef.current = Date.now();
    }
  }, [ensureJwt, historyCount]);

  useEffect(() => {
    if (currentTab === 'assistant' && jwtToken) {
      const now = Date.now();
      if (now - lastHistoryMetaFetchRef.current >= HISTORY_META_REFRESH_INTERVAL_MS) {
        refreshHistoryMeta().catch(() => {});
      }
    }
  }, [currentTab, jwtToken, refreshHistoryMeta]);

  useEffect(() => {
    let aborted = false;
    const loadCatalog = async () => {
      if (!jwtToken) { setShopItems([]); return; }
      try {
        const res = await fetch('/api/shop/catalog', { headers: { Authorization: `Bearer ${jwtToken}` } });
        if (!res.ok) return;
        const body = await res.json().catch(() => null);
        const items = Array.isArray(body?.items) ? body.items : [];
        if (!aborted) setShopItems(items);
      } catch { /* ignore */ }
    };
    loadCatalog();
    return () => { aborted = true; };
  }, [jwtToken]);

  const fetchQuests = async () => {
    const tok = await ensureJwt();
    if (!tok) return;
    const state: QuestStatePayload = await fetch('/api/quests/state', { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json());
    if (state && Array.isArray(state.quests)) {
      setQuests(state.quests);
      questsRef.current = state.quests;
      setQuestDefs(state.defs || {});
      setOfficial(state.official || null);
      setAvailableQuests(Array.isArray(state.available) ? state.available : []);
    } else {
      setQuests([]);
      questsRef.current = [];
      setQuestDefs({});
      setOfficial(null);
      setAvailableQuests([]);
    }
  };

  const fetchQuestsRef = useRef(fetchQuests);
  useEffect(() => {
    fetchQuestsRef.current = fetchQuests;
  }, [fetchQuests]);

  const clearQuestHighlight = useCallback(() => {
    if (questHighlightTimeoutRef.current) {
      window.clearTimeout(questHighlightTimeoutRef.current);
      questHighlightTimeoutRef.current = null;
    }
    setRecentlyAcceptedQuestId(null);
  }, []);

  const highlightAcceptedQuest = useCallback((questId: string) => {
    clearQuestHighlight();
    setRecentlyAcceptedQuestId(questId);
    questHighlightTimeoutRef.current = window.setTimeout(() => {
      setRecentlyAcceptedQuestId(null);
      questHighlightTimeoutRef.current = null;
    }, 12000);
  }, [clearQuestHighlight]);

  useEffect(() => {
    const quest1 = quests.find((q) => q.quest_id === 'quest1_x_link');
    if (quest1 && (quest1.status === 'completed' || quest1.status === 'rewarded')) {
      setXOauthStatus(null);
      setXOauthPending(false);
    }
  }, [quests]);

  useEffect(() => {
    const questTg = quests.find((q) => q.quest_id === 'quest1_telegram_link');
    if (questTg && (questTg.status === 'completed' || questTg.status === 'rewarded')) {
      setTelegramPending(false);
      setTelegramStatus(null);
    }
  }, [quests]);

  const stopXOauthTimers = () => {
    if (xOauthTimerRef.current) {
      window.clearTimeout(xOauthTimerRef.current);
      xOauthTimerRef.current = null;
    }
    if (xOauthClosePollRef.current) {
      window.clearInterval(xOauthClosePollRef.current);
      xOauthClosePollRef.current = null;
    }
  };

  const handleXOauthMessage = useCallback((ev: MessageEvent) => {
    if (!ev?.data || ev.data.source !== 'flashorca-x-oauth') return;
    const expectedOrigin = window.location.origin;
    if (!ev.origin || ev.origin !== expectedOrigin) return;
    if (xOauthWinRef.current && ev.source && ev.source !== xOauthWinRef.current) return;
    const expectedState = xOauthStateRef.current;
    const receivedState = typeof ev.data.state === 'string' ? ev.data.state : null;
    if (expectedState && receivedState !== expectedState) return;
    xOauthStateRef.current = null;
    stopXOauthTimers();
    try { xOauthWinRef.current?.close(); } catch { /* ignore */ }
    xOauthWinRef.current = null;
    setXOauthPending(false);
    const msg = typeof ev.data.message === 'string' ? ev.data.message : 'X sign-in updated';
    // 성공이면 상태 문구를 지우고, 실패/취소만 보여준다.
    setXOauthStatus(ev.data.ok ? null : msg);
    if (ev.data.ok) {
      fetchQuestsRef.current().catch(() => {});
    }
  }, []);

  useEffect(() => {
    window.addEventListener('message', handleXOauthMessage);
    return () => {
      window.removeEventListener('message', handleXOauthMessage);
    };
  }, [handleXOauthMessage]);

  useEffect(() => () => {
    stopXOauthTimers();
    xOauthStateRef.current = null;
    try { xOauthWinRef.current?.close(); } catch { /* ignore */ }
    xOauthWinRef.current = null;
    clearQuestHighlight();
  }, [clearQuestHighlight]);

  const startXOauth = useCallback(async () => {
    const tok = await ensureJwt();
    if (!tok) return;
    setXOauthStatus(null);
    setXOauthPending(true);
    stopXOauthTimers();
    xOauthStateRef.current = null;
    try {
      const resp = await fetch('/api/x/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      });
      const out = await resp.json().catch(() => null);
      if (!resp.ok || !out?.auth_url) {
        throw new Error(out?.error || `HTTP ${resp.status}`);
      }
      xOauthStateRef.current = typeof out.state === 'string' ? out.state : null;
      const popup = window.open(out.auth_url, 'flashorca-x', 'width=480,height=720');
      xOauthWinRef.current = popup;
      if (!popup) {
        setXOauthPending(false);
        setXOauthStatus('Allow pop-ups to sign in with X.');
        xOauthStateRef.current = null;
        return;
      }
      try { popup.focus(); } catch { /* ignore */ }
      xOauthTimerRef.current = window.setTimeout(() => {
        setXOauthPending(false);
        setXOauthStatus('Timed out waiting for X sign-in. Try again.');
        stopXOauthTimers();
        xOauthStateRef.current = null;
      }, 120_000);
      // detect user-closing popup (cancel) before callback
      xOauthClosePollRef.current = window.setInterval(() => {
        if (xOauthWinRef.current && xOauthWinRef.current.closed) {
          stopXOauthTimers();
          setXOauthPending(false);
          xOauthStateRef.current = null;
          xOauthWinRef.current = null;
          (async () => {
            try {
              await fetchQuestsRef.current();
              const q1 = questsRef.current.find((qq) => qq.quest_id === 'quest1_x_link');
              if (q1 && (q1.status === 'completed' || q1.status === 'rewarded')) {
                setXOauthStatus(null);
                return;
              }
            } catch { /* ignore */ }
            setXOauthStatus('X sign-in cancelled.');
          })();
        }
      }, 400);
      // Fallback poll: refresh quests a few seconds later even if postMessage fails
      setTimeout(() => fetchQuestsRef.current().catch(() => {}), 5000);
      setTimeout(() => fetchQuestsRef.current().catch(() => {}), 15000);
    } catch (err: any) {
      setXOauthPending(false);
      setXOauthStatus(err?.message || 'Failed to start X sign-in');
      xOauthStateRef.current = null;
    }
  }, [ensureJwt]);

  const ensureTelegramWidget = useCallback(async () => {
    if (telegramScriptPromiseRef.current) return telegramScriptPromiseRef.current;
    telegramScriptPromiseRef.current = new Promise((resolve) => {
      if ((window as any).Telegram?.Login?.auth) {
        resolve((window as any).Telegram);
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://telegram.org/js/telegram-widget.js?22';
      script.async = true;
      script.onload = () => resolve((window as any).Telegram || null);
      script.onerror = () => resolve(null);
      document.body.appendChild(script);
    });
    return telegramScriptPromiseRef.current;
  }, []);

  const verifyQuest = async (questId: string, payload: any) => {
    const tok = await ensureJwt();
    if (!tok) return null;
    try {
      const res = await fetch('/api/quests/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ quest_id: questId, payload })
      });
      let j: any = null;
      try {
        j = await res.json();
      } catch {
        j = null;
      }
      // even on validation errors, refresh so meta (e.g., challenge) shows
      await fetchQuests();
      if (!res.ok && j?.error) {
        const msg = `Verification failed: ${j.error}`;
        pushToast(msg, { type: 'error', title: 'Quest verification failed', source: 'quests' });
        return j ?? { ok: false, error: j?.error };
      }
      return j ?? { ok: res.ok };
    } catch (err: any) {
      try { await fetchQuests(); } catch { /* ignore */ }
      return { ok: false, error: err?.message || 'verify_failed' };
    }
  };

  const startTelegramLink = useCallback(async () => {
    const tok = await ensureJwt();
    if (!tok) return;
    const def = (questDefs || {})['quest1_telegram_link'] || {};
    const botId = def.telegram_bot_id || def.telegram_botId;
    const botUsername = def.telegram_bot_username || def.telegram_bot || def.bot_username;
    if (!botId || !botUsername) {
      setTelegramStatus('Telegram verification is not configured yet. Please try again shortly.');
      return;
    }
    const botIdNum = Number(botId);
    if (!Number.isFinite(botIdNum)) {
      setTelegramStatus('Telegram Bot ID configuration is invalid.');
      return;
    }
    setTelegramPending(true);
    setTelegramStatus(null);
    try {
      const tg: any = await ensureTelegramWidget();
      if (!tg || !tg.Login || typeof tg.Login.auth !== 'function') {
        setTelegramStatus('Could not load the Telegram login widget. Please try again.');
        telegramScriptPromiseRef.current = null;
        setTelegramPending(false);
        return;
      }
      tg.Login.auth(
        { bot_id: botIdNum, request_access: 'write', lang: 'en', origin: window.location.origin },
        async (user: any) => {
          try {
            setTelegramPending(false);
            if (!user || !user.hash) {
              setTelegramStatus('Telegram auth payload is empty.');
              return;
            }
            setTelegramStatus('Verifying Telegram signature…');
            const res = await verifyQuest('quest1_telegram_link', { telegram: user });
            if (res?.error) {
              setTelegramStatus(`Failed: ${res.error}`);
            } else {
              setTelegramStatus(null);
            }
          } catch (err: any) {
            setTelegramStatus(err?.message || 'An error occurred during Telegram verification.');
          }
        }
      );
      window.setTimeout(() => setTelegramPending(false), 120_000);
    } catch (err: any) {
      setTelegramPending(false);
      setTelegramStatus(err?.message || 'Could not start Telegram verification.');
    }
  }, [ensureJwt, ensureTelegramWidget, questDefs, verifyQuest]);

  useEffect(() => {
    if (jwtToken) {
      fetchQuests().catch(() => {});
    } else {
      setQuests([]);
      setAvailableQuests([]);
      setQuestRewardStates({});
    }
  }, [jwtToken]);

  const acceptQuest = useCallback(async (questId: string) => {
    const tok = await ensureJwt();
    if (!tok) return;
    setQuestAccepting(questId);
    try {
      const resp = await fetch('/api/quests/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ quest_id: questId }),
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => null);
        throw new Error(j?.error || `HTTP ${resp.status}`);
      }
      await fetchQuests();
      setCurrentTab('quests');
      highlightAcceptedQuest(questId);
      pushToast('Quest accepted. Continue in the Quests tab.', { type: 'success', title: 'Quest accepted', source: 'quests' });
    } catch (err: any) {
      const msg = `Failed to accept quest: ${err?.message || err}`;
      pushToast(msg, { type: 'error', title: 'Quest accept failed', source: 'quests' });
    } finally {
      setQuestAccepting(null);
    }
  }, [ensureJwt, fetchQuests, highlightAcceptedQuest]);

  

  const getQuestRewardLabel = useCallback((questId: string) => {
    if (questId === 'quest4_pop_uniq') {
      const lvl = rewardSnapshot?.popProfile?.levelIndex ?? 0;
      return lvl <= 0 ? 'Upgrade Pop Level' : 'Keep current Pop Level';
    }
    const def = (questDefs || {})[questId] || {};
    const popLabel = normalizePopLabel(def.reward_pop);
    if (typeof def.reward_rp === 'number' && def.reward_rp > 0) return `Get ${def.reward_rp} RP`;
    if (popLabel) return `Get PoP ${popLabel}`;
    return 'Get reward';
  }, [questDefs, rewardSnapshot?.popProfile?.levelIndex]);

  const getQuestRewardBadge = useCallback((questId: string) => {
    const def = (questDefs || {})[questId] || {};
    const popLabel = normalizePopLabel(def.reward_pop);
    if (questId === 'quest4_pop_uniq') {
      const currentLabel = rewardSnapshot?.popProfile?.levelLabel;
      if (currentLabel) return `PoP ${currentLabel}`;
    }
    if (typeof def.reward_rp === 'number' && def.reward_rp > 0) return `+${def.reward_rp} RP`;
    if (popLabel) return `PoP ${popLabel}`;
    return 'Reward';
  }, [questDefs, rewardSnapshot?.popProfile?.levelLabel]);

  const truncateSig = (sig?: string | null) => {
    if (!sig) return '';
    return sig.length > 12 ? `${sig.slice(0, 6)}…${sig.slice(-6)}` : sig;
  };

  const explorerTxUrl = (sig: string | null | undefined) => {
    if (!sig) return null;
    const clusterEnv = (import.meta.env.VITE_SOLANA_CLUSTER || '').toString().toLowerCase();
    const rpcEnv = (import.meta.env.VITE_SOLANA_RPC || '').toString().toLowerCase();
    const endpoint = (connection as any)?.rpcEndpoint as string | undefined;
    const onDevnet = clusterEnv === 'devnet'
      || rpcEnv.includes('devnet')
      || (endpoint ? endpoint.toLowerCase().includes('devnet') : false)
      || serverRpcIsDevnet;
    return `https://solscan.io/tx/${sig}${onDevnet ? '?cluster=devnet' : ''}`;
  };

  const updateQuestRewardState = useCallback((questId: string, next: Partial<QuestRewardState>) => {
    setQuestRewardStates((prev) => {
      const cur = prev[questId] ?? { status: 'idle', message: null, tx: null };
      return { ...prev, [questId]: { ...cur, ...next } };
    });
  }, []);

  const triggerSnapshotReload = useCallback((delays: number[] = [0, 1200, 3000]) => {
    // 여러 번 노출해 체인 최종 확정을 기다리며 UI를 최신화
    delays.forEach((ms) => {
      window.setTimeout(() => setSnapshotReloadNonce((n) => n + 1), ms);
    });
  }, []);

  const waitForSnapshotRefresh = useCallback(async (timeoutMs = 12_000) => {
    const started = Date.now();
    const initial = snapshotFetchedAtRef.current ?? 0;
    return new Promise<boolean>((resolve) => {
      const tick = () => {
        if ((snapshotFetchedAtRef.current ?? 0) > initial) {
          resolve(true);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          resolve(false);
          return;
        }
        window.setTimeout(tick, 300);
      };
      tick();
    });
  }, []);

  const finalizeTxMessageAfterRefresh = useCallback(
    async (
      setter: Dispatch<SetStateAction<TxMessage | null>>,
      opts: { tx?: string | null; refreshingText: string; finalText: string; timeoutText?: string },
    ) => {
      const refreshed = await waitForSnapshotRefresh();
      setter((prev) => {
        if (!prev) return prev;
        if (prev.tx !== opts.tx) return prev;
        if (prev.text !== opts.refreshingText) return prev;
        const nextText = refreshed ? opts.finalText : (opts.timeoutText ?? opts.finalText);
        return { text: nextText, tx: opts.tx };
      });
    },
    [waitForSnapshotRefresh],
  );

  const claimQuestReward = useCallback(async (questId: string) => {
    const tok = await ensureJwt();
    if (!tok) return;
    const label = getQuestRewardLabel(questId);
    updateQuestRewardState(questId, { status: 'pending', message: `${label} in progress…`, tx: null });
    try {
      const res = await fetch('/api/quests/claim_reward', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ quest_id: questId })
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.ok) {
        const msg = j?.message || j?.error || `HTTP ${res.status}`;
        throw new Error(msg);
      }
      const txSig = j?.tx_sig || j?.onchain?.tx_sig || null;
      const badge = getQuestRewardBadge(questId);
      const already = Boolean(j?.already);
      const parts = [`${already ? 'Reward already granted' : 'Reward granted'}: ${badge}`];
      if (txSig) parts.push(`tx ${truncateSig(txSig)}`);
      updateQuestRewardState(questId, { status: 'success', message: parts.join(' · '), tx: txSig });
      await fetchQuests();
      triggerSnapshotReload();
    } catch (e: any) {
      const msg = e?.message || 'Failed to grant reward.';
      updateQuestRewardState(questId, { status: 'error', message: msg, tx: null });
    }
  }, [ensureJwt, fetchQuests, getQuestRewardBadge, getQuestRewardLabel, triggerSnapshotReload, updateQuestRewardState]);

  const renderQuestRewardAction = (
    questId: string,
    disabled?: boolean,
    opts?: { showButton?: boolean; showMessageWhenHidden?: boolean; hideMessageOnSuccess?: boolean }
  ) => {
    const state = questRewardStates[questId];
    const claimedInSession = state?.status === 'success';
    const label = state?.status === 'pending' ? 'Processing…' : getQuestRewardLabel(questId);
    const color = state?.status === 'error' ? '#ff8080' : state?.status === 'success' ? '#8ef5b5' : '#cbd5f5';
    const showButton = (opts?.showButton ?? true) && !claimedInSession;
    const hideMessage = claimedInSession && opts?.hideMessageOnSuccess;
    const showMessage = !hideMessage && Boolean(state?.message) && (opts?.showMessageWhenHidden || showButton || state?.status !== 'idle');
    if (!showButton && !showMessage) return null;
    return (
      <div style={{ display: 'grid', gap: 4 }}>
        {showButton && (
          <button
            className="assistant-btn secondary"
            disabled={!!disabled || state?.status === 'pending'}
            onClick={() => claimQuestReward(questId)}
          >
            {label}
          </button>
        )}
        {showMessage && (
          <div className="assistant-subtle" style={{ color, display: 'grid', gap: 4 }}>
            <span>{state.message}</span>
            {state.tx && (
              <a
                href={explorerTxUrl(state.tx) ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: '#bde3ff' }}
              >
                View on Solscan ({truncateSig(state.tx)})
              </a>
            )}
          </div>
        )}
      </div>
    );
  };

  // Hide primary quest actions once 완료/보상 처리되어 더 이상 클릭할 필요가 없을 때
  const isQuestActionVisible = (status: string | undefined, rewardGranted: boolean) => {
    return status !== 'completed' && !rewardGranted;
  };

  const reportActivity = async (payload: { type: string; txid?: string; quest_id?: string; note?: string; extra?: any }) => {
    try {
      const tok = await ensureJwt();
      if (!tok) return;
      await fetch('/api/quests/report_activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify(payload),
      });
    } catch { /* no-op */ }
  };

  // Build optional context snippets from currently visible tabs
  const includeTabContext = (features as any)?.chatIncludeTabContext !== false;

  const buildQuestsContext = (): string => {
    try {
      const lines: string[] = [];
      if (official?.x_handle) lines.push(`Official X: @${official.x_handle}${official?.x_user_id ? ` (id ${official.x_user_id})` : ''}`);
      if (availableQuests && availableQuests.length > 0) {
        lines.push(`Outstanding Quests (${availableQuests.length}):`);
        for (const q of availableQuests) {
      const reward = q.reward_label
        || (typeof q.reward_rp === 'number' && q.reward_rp > 0 ? `+${q.reward_rp} RP` : (normalizePopLabel(q.reward_pop) ? `PoP ${normalizePopLabel(q.reward_pop)}` : ''));
      lines.push(`- ${q.quest_id}: ${q.title}${reward ? ` · reward=${reward}` : ''}`);
    }
  }
      if (quests && quests.length > 0) {
        lines.push(`Accepted Quests (${quests.length}):`);
        for (const q of quests) {
          const def = (questDefs || {})[q.quest_id] || {};
          const title = typeof def.title === 'string' && def.title.trim().length > 0 ? def.title : q.quest_id;
          const reward = (typeof def.reward_rp === 'number' && def.reward_rp > 0) ? `+${def.reward_rp} RP` : (normalizePopLabel(def.reward_pop) ? `PoP ${normalizePopLabel(def.reward_pop)}` : def.reward_label);
          const rewardState = questRewardStates[q.quest_id];
          const claimMsg = rewardState?.message || (rewardState?.status === 'success' ? 'rewarded (session)' : '');
          const tx = rewardState?.tx || (q as any).reward_tx_sig;
          const rewardLabel = reward || rewardState?.tx ? `reward=${reward || ''}${tx ? ` · tx=${truncateSig(tx)}` : ''}` : '';
          const detail = [rewardLabel, claimMsg].filter(Boolean).join(' | ');
          lines.push(`- ${q.quest_id}: ${title} · status=${q.status}${detail ? ` · ${detail}` : ''}`);
          if (q.meta && Object.keys(q.meta).length > 0) {
            lines.push(`  meta=${JSON.stringify(q.meta)}`);
          }
        }
      } else {
        lines.push('Accepted Quests: none');
      }
      const questsText = lines.join('\n');
      if (questsText) setCtxCache('quests', questsText);
      return questsText;
    } catch { return ''; }
  };

  const buildSnapshotContext = (): string => {
    const cached = loadCtxCache().snapshot || snapshotContextRef.current || '';
    try {
      const lines: string[] = [];
      if (typeof sol === 'number') lines.push(`SOL Balance: ${sol.toFixed(6)} SOL`);
      if (forcaTokenBalance) {
        lines.push(`FORCA Balance: ${forcaTokenBalance.uiAmountString}`);
      }
      if (quoteInfo) {
        lines.push(`Quote: FORCA/SOL=${Number(quoteInfo.forcaPerSolE6)/1_000_000} · SOL/USD=${formatMicroUsd(quoteInfo.solPriceUsdE6)}`);
      }
      if (vaultStateAccount) {
        const rawTotalRp = (vaultStateAccount as any)?.totalRp;
        const totalRp =
          typeof rawTotalRp === 'bigint'
            ? rawTotalRp
            : typeof rawTotalRp === 'number'
              ? BigInt(rawTotalRp)
              : null;
        const totalRpLabel = totalRp !== null ? formatAmount(totalRp, FORCA_DECIMALS, 'RP') : 'n/a';
        lines.push(`Vault state: paused=${vaultStateAccount.paused} · totalRP=${totalRpLabel}`);
        lines.push(`Vault config: allyCount=${rewardVaultConfig.allies.length} · mockOracle=${vaultStateAccount.useMockOracle} · mockLocked=${vaultStateAccount.mockOracleLocked}`);
        if (rewardVaultConfig.allies.length > 0) {
          lines.push('Ally benefits:');
          for (const ally of rewardVaultConfig.allies) {
            const allyAcc = allyAccountMap[ally.mintAddress];
            if (allyAcc) {
              lines.push(
                `- ${ally.label}: ${getBenefitModeLabel(allyAcc.benefitMode)} · ${formatBps(allyAcc.benefitBps)} · vaultBalance=${formatAmount(allyAcc.balanceForca, FORCA_DECIMALS, 'FORCA')}`,
              );
            } else {
              lines.push(`- ${ally.label}: benefit=loading`);
            }
          }
        }
      }
      if (rewardSnapshot) {
        if (rewardSnapshot.popProfile) {
          lines.push(`PoP Level: ${rewardSnapshot.popProfile.levelLabel} (last set: ${formatTimestamp(rewardSnapshot.popProfile.lastSetTs)})`);
        }
        if (rewardSnapshot.ledgers && rewardSnapshot.ledgers.length > 0) {
          lines.push(`Ledgers (${rewardSnapshot.ledgers.length}):`);
          for (const l of rewardSnapshot.ledgers) {
            const label = l.ally?.label || l.ally?.mintAddress || 'ally';
            lines.push(`- ${label}: RP=${formatAmount(l.rpClaimable, FORCA_DECIMALS)} · PP=${formatAmount(l.ppBalance, FORCA_DECIMALS)} · allyMint=${l.ally?.mintAddress ?? ''}`);
          }
        }
      }
      const snapshotText = lines.join('\n').trim();
      const rich = isSnapshotRich(snapshotText);
      const nextSnapshot = snapshotText || cached || '';
      if (snapshotText) {
        snapshotContextRef.current = snapshotText;
        // rewardSnapshot이 존재하면 비록 덜 풍부해도 저장해 추후 null 방지
        setCtxCache('snapshot', snapshotText, { allowShallow: !rich && !!rewardSnapshot });
      } else if (cached) {
        snapshotContextRef.current = cached;
      }
      // 빈약한 데이터만 있을 때는 직전 캐시가 있으면 재사용
      if (!rich && cached) return cached;
      return nextSnapshot;
    } catch (err) {
      console.error('buildSnapshotContext failed', err);
      return cached || '';
    }
  };

  const buildShopContext = (): string => {
    try {
      const lines: string[] = [];
      lines.push(`PP balance (snapshot): ${formatAmount(totalPpBalance, FORCA_DECIMALS, 'PP')}`);
      if (chatQuota) {
        lines.push(`Chat quota: ${chatQuota.remaining}/${chatQuota.initial}`);
      }
      if (shopItems && shopItems.length > 0) {
        lines.push(`Catalog (${shopItems.length}):`);
        for (const item of shopItems) {
          const price = item?.price;
          const priceLabel = price ? `${price.currency}:${price.amount}` : 'n/a';
          lines.push(`- ${item.id}: ${item.title} · kind=${item.kind} · price=${priceLabel}${item.description ? ` · ${item.description}` : ''}`);
        }
      }
      if (donateAmount) {
        lines.push(`Donate input: amount=${donateAmount}${donateNote ? ` note=${donateNote}` : ''}`);
      }
      if (donateMsg?.text) {
        lines.push(`Last donate: ${donateMsg.text}${donateMsg.tx ? ` · tx ${truncateSig(donateMsg.tx)}` : ''}`);
      }
      if (chatBuyBusy) {
        lines.push('Chat pack purchase: in_progress');
      }
      if (chatBuyMsg?.text) {
        lines.push(`Last chat pack: ${chatBuyMsg.text}${chatBuyMsg.tx ? ` · tx ${truncateSig(chatBuyMsg.tx)}` : ''}`);
      }
      const shopText = lines.join('\n');
      if (shopText) setCtxCache('shop', shopText);
      return shopText;
    } catch { return ''; }
  };

  const buildHistoryContext = (): string => {
    try {
      const lines: string[] = [];
      const filtersActive = timelineFilters.length === historySourceOrder.length
        ? 'all'
        : timelineFilters.map((f) => historySourceLabels[f] || f).join(', ');
      const countsLine = historySourceOrder
        .map((src) => `${historySourceLabels[src] || src}=${timelineCounts?.[src] ?? 0}`)
        .join(' · ');
      lines.push(`Filters: ${filtersActive}`);
      lines.push(`Counts: ${countsLine}`);

      const latestEntries = timelineEntries.slice(0, 10);
      if (latestEntries.length > 0) {
        lines.push(`Timeline (${latestEntries.length}${timelineHasMore ? '+' : ''} shown):`);
        for (const item of latestEntries) {
          const ts = formatDateTime(item.ts ?? null) || item.ts || 'n/a';
          const detailParts = [
            item.amount_label ? item.amount_label : null,
            item.status ? `status=${item.status}` : null,
            item.subtitle ? item.subtitle : null,
            item.slot ? `slot=${item.slot}` : null,
            item.txid ? `tx=${truncateSig(item.txid)}` : null,
          ].filter(Boolean);
          const details = detailParts.length > 0 ? ` · ${detailParts.join(' · ')}` : '';
          lines.push(`- [${historySourceLabels[item.source] || item.source}] ${item.title || 'Event'} · ${ts}${details}`);
        }
      } else {
        lines.push('Timeline: (no entries loaded)');
      }

      const savedCount = historyCount || historyItems.length;
      const baseChatLine = `Chat history saved: ${savedCount}${historyPanelOpen ? ' · panel=open' : ''}`;
      lines.push(historyError ? `${baseChatLine} · last_error=${historyError}` : baseChatLine);

      const safeText = (txt: string, max = 160) => (txt.length > max ? `${txt.slice(0, max)}…` : txt);
      const recentChats = historyItems.slice(0, 5);
      if (recentChats.length > 0) {
        lines.push('Recent chats:');
        for (const h of recentChats) {
          const ts = formatDateTime(h.ts) || h.ts || '';
          lines.push(`- ${h.role}: ${safeText(h.text)}${ts ? ` (${ts})` : ''}`);
        }
      }

      return lines.join('\n').trim();
    } catch (err) {
      console.error('buildHistoryContext failed', err);
      return '';
    }
  };

  const buildUxContext = (): { text: string; logCount: number } => {
    const lines: string[] = [];
    const logs = readUxLogs();
    const pk = publicKey?.toBase58();
    lines.push(`UI: tab=${currentTab} · connected=${connected} · wallet=${pk ? truncateSig(pk) : 'none'} · jwt=${jwtToken ? 'yes' : 'no'}`);
    lines.push(`State: chatSending=${chatSending} · quests=${quests.length} · availableQuests=${availableQuests.length} · history=${historyItems.length}`);
    if (rewardSnapshot) {
      lines.push(`Reward snapshot loaded: ledgers=${rewardSnapshot.ledgers?.length ?? 0} · pop=${rewardSnapshot.popProfile?.levelLabel ?? 'n/a'}`);
    }
    if (logs.length > 0) {
      lines.push('UX Logs:');
      for (const l of logs) {
        const ts = new Date(l.ts).toISOString();
        lines.push(`[${ts}][${l.level}${l.source ? `/${l.source}` : ''}] ${l.message}`);
      }
    }
    const text = lines.join('\n');
    return { text, logCount: logs.length };
  };

  const sendAssistantMessage = async (text: string) => {
    if (chatSending) return;
    const tok = await ensureJwt();
    if (!tok) return;
    if (contextPeekActive) {
      setContextPreview((prev) => ({
        ...(prev || { sections: [] }),
        userQuestion: text,
        ts: new Date().toISOString(),
        pending: true,
      }));
    }
    setChatSending(true);
    const addrHint = publicKey?.toBase58();
    const cachedPass = turnstileEnabled ? loadTurnstilePass(addrHint) : null;
    const passValid = !!(cachedPass && cachedPass.exp > Date.now() && (!cachedPass.addr || !addrHint || cachedPass.addr === addrHint));
    const shouldSkipTurnstile = turnstileEnabled && passValid;
    let cfToken: string | null = null;
    if (turnstileEnabled && !shouldSkipTurnstile) {
      try {
        cfToken = await ensureTurnstileToken();
      } catch (e: any) {
        appendAssistantMessage('bot', 'A temporary security check error occurred. Please try again shortly.');
        setChatSending(false);
        return;
      }
    }
    appendAssistantMessage('user', text);
    try {
      const payload: any = { chat_message: text };
      if (contextPeekActive) {
        payload.debug_context = true;
      }
      if (turnstileEnabled && cfToken) {
        payload.turnstile_token = cfToken;
      }
      if (includeTabContext) {
        const questsText = buildQuestsContext();
        const snapshotText = buildSnapshotContext();
        const shopText = buildShopContext();
        const historyText = buildHistoryContext();
        const cached = loadCtxCache();
        if (questsText) payload.quests_context = questsText;
        const snapshotPayload = snapshotText || cached.snapshot || snapshotContextRef.current;
        if (snapshotPayload) payload.snapshot_context = snapshotPayload;
        if (shopText) payload.shop_context = shopText;
        if (historyText) payload.history_context = historyText;
        if (!payload.quests_context && cached.quests) payload.quests_context = cached.quests;
        if (!payload.snapshot_context && snapshotContextRef.current) payload.snapshot_context = snapshotContextRef.current;
        if (!payload.snapshot_context && cached.snapshot) payload.snapshot_context = cached.snapshot;
        if (!payload.shop_context && cached.shop) payload.shop_context = cached.shop;
      }
      const uxLogs = readUxLogs();
      const uxCtx = buildUxContext();
      let uxLogsCleared = false;
      const flushUxLogs = () => {
        if (!uxLogsCleared && uxLogs.length > 0) {
          clearUxLogsStorage();
          uxLogsCleared = true;
        }
      };
      if (uxCtx.text) {
        payload.ux_context = uxCtx.text;
        payload.ux_log_count = uxCtx.logCount;
      }
      const sendOnce = async (body: any, allowRetry: boolean): Promise<void> => {
        const resp = await fetch('/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
          body: JSON.stringify(body),
        });
        flushUxLogs();
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          if (err?.error === 'chat_quota_exhausted') {
            const msg = String(err?.message ?? 'Your AI chat quota is exhausted.');
            appendAssistantMessage('bot', msg);
            setChatQuota({ remaining: 0, initial: chatQuota?.initial ?? 10, purchase_url: err?.purchase_url });
            if (contextPeekActive) {
              setContextPreview((prev) => prev ? { ...prev, pending: false } : null);
            }
            return;
          }
          if (err?.error === 'turnstile_failed' && allowRetry && turnstileEnabled) {
            // 새 토큰으로 1회 재시도
            resetTurnstile();
            clearTurnstilePass();
            const nextToken = await ensureTurnstileToken();
            const nextBody = { ...body, turnstile_token: nextToken };
            return sendOnce(nextBody, false);
          }
          const msg = err?.message || 'Turnstile verification failed. Please retry.';
          appendAssistantMessage('bot', msg);
          if (contextPeekActive) {
            setContextPreview((prev) => prev ? { ...prev, pending: false } : null);
          }
          return;
        }
        const res = await resp.json();
        const reply = String(res?.response_message ?? 'Unable to load a response.');
        if (contextPeekActive) {
          const dbg = res?.context_debug;
          if (dbg) {
            const sections: ContextDebugSection[] = Array.isArray(dbg.sections)
              ? dbg.sections.map((s: any, idx: number) => ({
                title: typeof s?.title === 'string' ? s.title : `Context ${idx + 1}`,
                text: typeof s?.text === 'string' ? s.text : (typeof s === 'string' ? s : null),
                length: typeof s?.length === 'number' ? s.length : null,
              })).filter((s: ContextDebugSection) => !!s.text)
              : [];
            const clientContext = dbg?.client_context && typeof dbg.client_context === 'object' && dbg.client_context !== null
              ? Object.entries(dbg.client_context).reduce<Record<string, string>>((acc, [k, v]) => {
                if (v === undefined || v === null) return acc;
                acc[k] = typeof v === 'string' ? v : JSON.stringify(v);
                return acc;
              }, {})
              : undefined;
            setContextPreview({
              sections,
              augmented: typeof dbg.augmented_prompt === 'string' ? dbg.augmented_prompt : null,
              userQuestion: typeof dbg.user_question === 'string' ? dbg.user_question : text,
              ts: typeof dbg.ts === 'string' ? dbg.ts : new Date().toISOString(),
              clientContext: clientContext && Object.keys(clientContext).length > 0 ? clientContext : undefined,
              pending: false,
            });
            setContextPeekOpen(true);
          } else {
            setContextPreview((prev) => prev ? { ...prev, pending: false } : { sections: [], userQuestion: text, ts: new Date().toISOString(), pending: false });
          }
        } else {
          setContextPreview(null);
          setContextPeekOpen(false);
        }
        appendAssistantMessage('bot', reply);
        if (turnstileEnabled) {
          storeTurnstilePass(addrHint);
        }
        if (typeof res?.remaining_quota === 'number') {
          setChatQuota((q) => ({ remaining: res.remaining_quota, initial: typeof res?.initial_quota === 'number' ? res.initial_quota : (q?.initial ?? 10), purchase_url: q?.purchase_url }));
        }
      };

      await sendOnce(payload, true);
    } catch (e: any) {
      const msg = e?.message || 'An error occurred while sending the message. Please try again.';
      appendAssistantMessage('bot', msg);
      if (contextPeekActive) {
        setContextPreview((prev) => prev ? { ...prev, pending: false } : null);
      }
    } finally {
      if (turnstileEnabled) {
        resetTurnstile();
        void renderTurnstile();
      }
      setChatSending(false);
    }
  };

  const loadChatHistory = async () => {
    const tok = await ensureJwt();
    if (!tok) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const items: ChatHistoryItem[] = await fetch('/chat_history?limit=50', {
        headers: { Authorization: `Bearer ${tok}` },
      }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });
      const normalized = Array.isArray(items) ? items : [];
      setHistoryItems(normalized);
      setHistoryPanelOpen(normalized.length > 0);
      setHistoryAvailable(normalized.length > 0);
    } catch (e: any) {
      setHistoryError(e?.message || 'Could not load history');
      pushToast(`Could not load chat history: ${e?.message || 'unknown error'}`, { type: 'error', title: 'History load failed', source: 'chat-history' });
    } finally {
      setHistoryLoading(false);
    }
  };

  const clearChatHistory = async () => {
    const tok = await ensureJwt();
    if (!tok) return;
    if (!window.confirm('Clear your chat history? This action cannot be undone.')) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      await fetch('/chat_history/clear', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}` },
      }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });
      setHistoryItems([]);
      setHistoryPanelOpen(false);
      setHistoryAvailable(false);
      setHistoryCount(0);
      pushToast('Chat history cleared.', { type: 'success', title: 'History cleared', source: 'chat-history' });
    } catch (e: any) {
      setHistoryError(e?.message || 'Could not clear history');
      pushToast(`Failed to clear chat history: ${e?.message || 'unknown error'}`, { type: 'error', title: 'History clear failed', source: 'chat-history' });
    } finally {
      setHistoryLoading(false);
    }
  };

  const HISTORY_PAGE_SIZE = 10;

  const fetchHistoryTimeline = useCallback(async (opts?: { force?: boolean; reset?: boolean }) => {
    if (timelineLoadingRef.current && !opts?.force) return;
    const now = Date.now();
    if (!opts?.force && now - lastTimelineFetchRef.current < 1_200) return;
    const tok = await ensureJwt();
    if (!tok) return;
    const requestId = ++timelineRequestIdRef.current;
    const useCursor = opts?.reset ? null : timelineCursorRef.current;
    const sources = timelineFilters.length === historySourceOrder.length ? null : timelineFilters.join(',');
    setTimelineLoading(true);
    timelineLoadingRef.current = true;
    setTimelineError(null);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(HISTORY_PAGE_SIZE));
      if (useCursor) params.set('cursor', useCursor);
      if (sources) params.set('sources', sources);
      const res = await fetch(`/api/history/timeline?${params.toString()}`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json().catch(() => null);
      const items: TimelineEntry[] = Array.isArray(body?.items) ? body.items : [];
      const sorted = [...items].sort((a, b) => (b?.ts_epoch ?? 0) - (a?.ts_epoch ?? 0));
      if (requestId !== timelineRequestIdRef.current) return;
      setTimelineEntries((prev) => (opts?.reset ? sorted : [...prev, ...sorted]));
      setTimelineCounts(typeof body?.counts === 'object' && body?.counts !== null ? body.counts : {});
      const nextCursor = typeof body?.next_cursor === 'string' && body.next_cursor.length > 0 ? body.next_cursor : null;
      setTimelineCursor(nextCursor);
      timelineCursorRef.current = nextCursor;
      setTimelineHasMore(Boolean(body?.has_more));
      lastTimelineFetchRef.current = Date.now();
    } catch (e: any) {
      const msg = e?.message || 'Could not load activity history.';
      if (requestId !== timelineRequestIdRef.current) return;
      setTimelineError(msg);
      setTimelineHasMore(false);
      if (opts?.reset) setTimelineEntries([]);
      pushToast(msg, { type: 'error', title: 'History load failed', source: 'history' });
    } finally {
      if (requestId === timelineRequestIdRef.current) {
        setTimelineLoading(false);
        timelineLoadingRef.current = false;
      }
    }
  }, [ensureJwt, pushToast, timelineFilters]);

  const refreshChatQuota = useCallback(async () => {
    const tok = await ensureJwt();
    if (!tok) return;
    try {
      const data = await fetch('/chat_quota', { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json());
      const remaining = typeof data?.remaining === 'number' ? data.remaining : null;
      if (remaining !== null) setChatQuota({ remaining, initial: typeof data?.initial === 'number' ? data.initial : 10, purchase_url: data?.purchase_url });
    } catch { /* no-op */ }
    finally {
      lastQuotaFetchRef.current = Date.now();
    }
  }, [ensureJwt]);

  useEffect(() => {
    if (currentTab === 'assistant' && jwtToken) {
      const now = Date.now();
      if (now - lastQuotaFetchRef.current >= QUOTA_REFRESH_INTERVAL_MS) {
        refreshChatQuota().catch(() => {});
      }
    }
  }, [currentTab, jwtToken, refreshChatQuota]);

  const defaultPurchaseUrl = useMemo(() => {
    const envUrl = (import.meta.env.VITE_PURCHASE_URL ?? '').toString().trim();
    if (envUrl) return envUrl;
    if (typeof window !== 'undefined') return `${window.location.origin}/#buy-quota`;
    return 'https://flashorca.com/#buy-quota';
  }, []);

  const openBuyQuota = useCallback(() => {
    const url = chatQuota?.purchase_url || defaultPurchaseUrl;
    try { window.open(url, '_blank', 'noopener'); } catch { window.location.href = url; }
  }, [chatQuota, defaultPurchaseUrl]);

  // 탭 전환 시 데이터 준비
  useEffect(() => {
    if (currentTab === 'quests' && jwtToken) {
      fetchQuests().catch(() => {});
    }
  }, [currentTab, jwtToken]);

  useEffect(() => {
    if (currentTab === 'history' && connected) {
      fetchHistoryTimeline({ force: true, reset: true }).catch(() => {});
    }
  }, [currentTab, connected, fetchHistoryTimeline, timelineFilters]);

  useEffect(() => {
    if (!jwtToken) {
      setTimelineEntries([]);
      setTimelineCounts({});
      setTimelineError(null);
      setTimelineCursor(null);
      setTimelineHasMore(false);
      setTimelineLoading(false);
      timelineRequestIdRef.current += 1;
      timelineCursorRef.current = null;
      timelineLoadingRef.current = false;
    }
  }, [jwtToken]);

  useEffect(() => {
    timelineCursorRef.current = timelineCursor;
  }, [timelineCursor]);

  useEffect(() => {
    timelineLoadingRef.current = timelineLoading;
  }, [timelineLoading]);

  useEffect(() => {
    let aborted = false;

    if (!connected || !publicKey || !walletDataVisible) {
      if (!connected) {
        setSol(null);
        setSpl([]);
      }
      return () => { aborted = true; };
    }

    const now = Date.now();
    const cooldownPassed = now - lastWalletFetchRef.current >= WALLET_FETCH_COOLDOWN_MS || lastWalletFetchRef.current === 0;
    if (!cooldownPassed) {
      return () => { aborted = true; };
    }
    lastWalletFetchRef.current = now;

    async function load() {
      if (!publicKey) { setSol(null); setSpl([]); return; }

      const owner = publicKey as PublicKey;

      // ① SOL
      const lamports = await connection.getBalance(owner, 'processed');
      if (!aborted) setSol(lamports / LAMPORTS_PER_SOL);

      // ②,③ SPL & Token-2022 (병렬)
      const [legacy, t22] = await Promise.all([
        connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
        connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
      ]);

      const pick = (a: any) => {
        const info = a.account.data.parsed.info;
        const amt = info.tokenAmount;
        return {
          mint: info.mint as string,
          uiAmount: Number(amt.uiAmount ?? 0),
          uiAmountString: String(amt.uiAmountString ?? '0'),
          decimals: Number(amt.decimals ?? 0),
        };
      };

      const list = [...legacy.value, ...t22.value]
        .map(pick)
        .filter(t => t.uiAmount > 0)
        .sort((a, b) => b.uiAmount - a.uiAmount);

      if (!aborted) setSpl(list);
    }
    load().catch(console.error);
    return () => { aborted = true; };
  }, [connected, walletDataVisible, publicKey?.toBase58(), connection, snapshotReloadNonce]);

  useEffect(() => {
    let aborted = false;

    if (!connected || !publicKey) {
      setRewardSnapshot(null);
      setRewardError(null);
      setRewardLoading(false);
      return () => { aborted = true; };
    }

    if (!rewardSnapshotQueriesEnabled) {
      return () => { aborted = true; };
    }

    setRewardLoading(true);
    setRewardError(null);

    fetchRewardVaultSnapshot(connection, publicKey, rewardVaultConfig, { commitment: 'processed' })
      .then((snapshot) => {
        if (!aborted) {
          setRewardSnapshot(snapshot);
          snapshotFetchedAtRef.current = Date.now();
        }
      })
      .catch((err) => {
        if (!aborted) {
          const message = err instanceof Error ? err.message : String(err);
          setRewardError(message);
          setRewardSnapshot(null);
        }
      })
      .finally(() => {
        if (!aborted) setRewardLoading(false);
      });

    return () => { aborted = true; };
  }, [connected, rewardSnapshotQueriesEnabled, publicKey?.toBase58(), connection, rewardVaultConfig, snapshotReloadNonce]);

  useEffect(() => {
    let aborted = false;
    if (!connected) {
      setVaultStateAccount(null);
      setMockOracleAccount(null);
      setMockPoolAccount(null);
      return () => { aborted = true; };
    }

    if (!rewardInfraQueriesEnabled) {
      return () => { aborted = true; };
    }

    fetchVaultStateAccount(connection, rewardVaultConfig.programId, 'processed')
      .then((state) => {
        if (!aborted) setVaultStateAccount(state);
      })
      .catch((err) => {
        console.error('failed to fetch vault state', err);
        if (!aborted) setVaultStateAccount(null);
      });

    return () => { aborted = true; };
  }, [connected, rewardInfraQueriesEnabled, connection, rewardVaultConfig]);

  useEffect(() => {
    let aborted = false;
    if (!connected) {
      setAllyAccountMap({});
      return () => { aborted = true; };
    }
    if (!rewardInfraQueriesEnabled) {
      return () => { aborted = true; };
    }
    const load = async () => {
      const entries = await Promise.all(
        rewardVaultConfig.allies.map(async (ally) => {
          try {
            const acct = await fetchAllyAccount(connection, rewardVaultConfig.programId, ally.mint, 'processed');
            return [ally.mintAddress, acct ?? null] as const;
          } catch (err) {
            console.error('failed to fetch ally account', ally.mintAddress, err);
            return [ally.mintAddress, null] as const;
          }
        }),
      );
      if (!aborted) {
        const next: Record<string, AllyAccountState | null> = {};
        for (const [key, value] of entries) next[key] = value;
        setAllyAccountMap(next);
      }
    };
    load().catch((err) => console.error('ally account load error', err));
    return () => { aborted = true; };
  }, [connected, rewardInfraQueriesEnabled, connection, rewardVaultConfig]);

  useEffect(() => {
    let aborted = false;
    if (!connected) {
      setMockOracleAccount(null);
      setMockPoolAccount(null);
      return () => { aborted = true; };
    }
    if (!rewardInfraQueriesEnabled) {
      return () => { aborted = true; };
    }
    if (!vaultStateAccount || !vaultStateAccount.useMockOracle) {
      setMockOracleAccount(null);
      setMockPoolAccount(null);
      return () => { aborted = true; };
    }
    fetchMockOracleSolAccount(connection, rewardVaultConfig.programId, 'processed')
      .then((acct) => {
        if (!aborted) setMockOracleAccount(acct);
      })
      .catch((err) => {
        console.error('failed to fetch mock oracle', err);
        if (!aborted) setMockOracleAccount(null);
      });
    fetchMockPoolForcaAccount(connection, rewardVaultConfig.programId, 'processed')
      .then((acct) => {
        if (!aborted) setMockPoolAccount(acct);
      })
      .catch((err) => {
        console.error('failed to fetch mock pool', err);
        if (!aborted) setMockPoolAccount(null);
      });
    return () => { aborted = true; };
  }, [connected, rewardInfraQueriesEnabled, connection, rewardVaultConfig, vaultStateAccount?.useMockOracle]);

  useEffect(() => {
    if (!connected) {
      setActionState({});
    }
  }, [connected]);

  useEffect(() => {
    if (snapshotFocusTimeoutRef.current) {
      window.clearTimeout(snapshotFocusTimeoutRef.current);
      snapshotFocusTimeoutRef.current = null;
    }
    if (!snapshotFocus) return;
    snapshotFocusTimeoutRef.current = window.setTimeout(() => {
      setSnapshotFocus(null);
      snapshotFocusTimeoutRef.current = null;
    }, 10000);
    return () => {
      if (snapshotFocusTimeoutRef.current) {
        window.clearTimeout(snapshotFocusTimeoutRef.current);
        snapshotFocusTimeoutRef.current = null;
      }
    };
  }, [snapshotFocus]);

  useEffect(() => {
    if (!snapshotFocus || currentTab !== 'snapshot') return;
    const target = snapshotActionRefs.current[snapshotFocus.allyMint]?.[snapshotFocus.action];
    if (!target) return;
    const raf = window.requestAnimationFrame(() => {
      setTimeout(() => {
        try {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch { /* no-op */ }
      }, 80);
    });
    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [snapshotFocus, currentTab, rewardSnapshot]);

  useEffect(() => {
    if (!rewardInfraQueriesEnabled || !vaultStateAccount) {
      if (!rewardInfraQueriesEnabled) {
        setQuoteInfo(null);
        setQuoteError(null);
        lastQuoteFetchRef.current = 0;
      }
      return;
    }
    let aborted = false;
    const refresh = async () => {
      const now = Date.now();
      if (now - lastQuoteFetchRef.current < 3500) return;
      lastQuoteFetchRef.current = now;
      try {
        const quote = await fetchQuote(vaultStateAccount);
        const forcaUsdE6 = (quote.solPriceUsdE6 * MICRO_SCALE) / quote.forcaPerSolE6;
        if (!aborted) {
          setQuoteInfo({
            solPriceUsdE6: quote.solPriceUsdE6,
            forcaPerSolE6: quote.forcaPerSolE6,
            forcaUsdE6,
            updatedAt: Date.now(),
          });
          setQuoteError(null);
        }
      } catch (err: any) {
        if (!aborted) {
          setQuoteInfo(null);
          setQuoteError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    const refreshVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      refresh();
    };
    refreshVisible();
    return () => {
      aborted = true;
    };
  }, [
    rewardInfraQueriesEnabled,
    vaultStateAccount,
    rewardVaultConfig.programId.toBase58(),
    rewardVaultConfig.poolForcaReserve ? rewardVaultConfig.poolForcaReserve.toBase58() : '',
    rewardVaultConfig.poolSolReserve ? rewardVaultConfig.poolSolReserve.toBase58() : '',
  ]);

  const getActionState = (allyMint: string): AllyActionState =>
    actionState[allyMint] ?? createDefaultActionState();

  const updateActionState = (allyMint: string, updater: (prev: AllyActionState) => AllyActionState) => {
    setActionState((prev) => {
      const current = prev[allyMint] ?? createDefaultActionState();
      const next = updater(current);
      return { ...prev, [allyMint]: next };
    });
  };

  const pushConvertDebug = (allyMint: string, msg: string) => {
    const stamp = new Date().toLocaleTimeString(undefined, { hour12: false });
    setActionState((prev) => {
      const cur = prev[allyMint] ?? createDefaultActionState();
      const next: AllyActionState = { ...cur, convertDebug: [...(cur.convertDebug ?? []), `[${stamp}] ${msg}`] };
      return { ...prev, [allyMint]: next };
    });
  };
  const pushClaimDebug = (allyMint: string, msg: string) => {
    const stamp = new Date().toLocaleTimeString(undefined, { hour12: false });
    setActionState((prev) => {
      const cur = prev[allyMint] ?? createDefaultActionState();
      const next: AllyActionState = { ...cur, claimDebug: [...(cur.claimDebug ?? []), `[${stamp}] ${msg}`] };
      return { ...prev, [allyMint]: next };
    });
  };

  const parseDecimalAmount = (raw: string, decimals: number): bigint | null => {
    const cleaned = raw.replace(/,/g, '').trim();
    if (!cleaned || cleaned === '.' || cleaned === '-') return null;
    if (!/^\d*(\.\d*)?$/.test(cleaned)) return null;
    const [wholePart = '0', fractionPart = ''] = cleaned.split('.');
    if (!/^\d+$/.test(wholePart)) return null;
    if (!/^\d*$/.test(fractionPart)) return null;
    if (fractionPart.length > decimals) return null;
    const whole = BigInt(wholePart || '0');
    const fractionPadded = fractionPart.padEnd(decimals, '0');
    const fraction = fractionPadded ? BigInt(fractionPadded) : 0n;
    const scale = 10n ** BigInt(decimals);
    const value = whole * scale + fraction;
    if (value < 0 || value > MAX_U64) return null;
    return value;
  };

  const formatBigintToInput = (value: bigint, decimals: number): string => {
    if (value === 0n) return '0';
    const negative = value < 0n;
    const abs = negative ? -value : value;
    const scale = 10n ** BigInt(decimals);
    const whole = abs / scale;
    let fraction = (abs % scale).toString().padStart(decimals, '0');
    fraction = fraction.replace(/0+$/, '');
    const body = fraction.length > 0 ? `${whole.toString()}.${fraction}` : whole.toString();
    return negative ? `-${body}` : body;
  };

  const ensureVaultState = async (): Promise<VaultStateAccount> => {
    if (vaultStateAccount) return vaultStateAccount;
    const fetched = await fetchVaultStateAccount(connection, rewardVaultConfig.programId, 'processed');
    if (!fetched) throw new Error('Vault state account not found');
    setVaultStateAccount(fetched);
    return fetched;
  };

  const ensureAllyAccount = async (allyMint: PublicKey): Promise<AllyAccountState> => {
    const key = allyMint.toBase58();
    const cached = allyAccountMap[key];
    if (cached) return cached;
    const fetched = await fetchAllyAccount(connection, rewardVaultConfig.programId, allyMint, 'processed');
    if (!fetched) throw new Error('Ally account not found');
    setAllyAccountMap((prev) => ({ ...prev, [key]: fetched }));
    return fetched;
  };

  const ensureMockAccounts = async () => {
    const programId = rewardVaultConfig.programId;
    let oracle = mockOracleAccount;
    if (!oracle) {
      try {
        const fetched = await fetchMockOracleSolAccount(connection, programId, 'processed');
        if (fetched) {
          oracle = fetched;
          setMockOracleAccount(fetched);
        }
      } catch (err) {
        console.error('mock oracle fetch error', err);
      }
    }
    let pool = mockPoolAccount;
    if (!pool) {
      try {
        const fetched = await fetchMockPoolForcaAccount(connection, programId, 'processed');
        if (fetched) {
          pool = fetched;
          setMockPoolAccount(fetched);
        }
      } catch (err) {
        console.error('mock pool fetch error', err);
      }
    }
    return {
      oracleAccount: oracle ?? null,
      poolAccount: pool ?? null,
      oracleAddress: oracle?.address ?? deriveMockOracleSolPda(programId),
      poolAddress: pool?.address ?? deriveMockPoolForcaPda(programId),
    };
  };

  const calcConfBps = (price: bigint, conf: bigint): bigint | null => {
    if (price === 0n) return null;
    const absPrice = price < 0n ? -price : price;
    if (absPrice === 0n) return null;
    return (conf * 10_000n) / absPrice;
  };

  const fetchSolPriceUsdE6FromFeed = async (feed: PublicKey, maxConfBps?: number) => {
    if (!feed || feed.equals(PublicKey.default)) {
      throw new Error('Pyth SOL/USD feed not configured');
    }
    const info = await connection.getAccountInfo(feed, 'processed');
    if (!info) throw new Error('Pyth price feed account unavailable');
    const parsed = parseAnchorPriceMessageAccount(info.data) ?? parsePythPriceAccount(info.data);
    if (!parsed) throw new Error('Unable to parse Pyth price data');
    const nowSec = Math.floor(Date.now() / 1000);
    const publishTs = Number(parsed.publishTime ?? 0);
    if (publishTs > 0 && rewardVaultConfig.pythMaxStaleSecs > 0 && nowSec - publishTs > rewardVaultConfig.pythMaxStaleSecs) {
      throw new Error('Oracle price is stale. Run Hermes update step to refresh the price feed.');
    }
    if (maxConfBps && maxConfBps > 0) {
      const confBps = calcConfBps(parsed.price, parsed.conf);
      if (confBps === null) throw new Error('Invalid oracle confidence data');
      if (confBps > BigInt(maxConfBps)) {
        throw new Error('Oracle confidence interval too wide. Try again later.');
      }
    }
    const scaled = scalePriceToMicroUsd(parsed.price, parsed.expo);
    if (scaled === null) throw new Error('Invalid Pyth price value');
    return scaled;
  };

  const fetchQuote = async (
    vault: VaultStateAccount,
  ): Promise<{ solPriceUsdE6: bigint; forcaPerSolE6: bigint }> => {
    if (vault.useMockOracle) {
      const { oracleAccount, poolAccount } = await ensureMockAccounts();
      if (!oracleAccount || !poolAccount) throw new Error('Mock oracle accounts unavailable');
      return {
        solPriceUsdE6: oracleAccount.solUsdE6,
        forcaPerSolE6: poolAccount.forcaPerSolE6,
      };
    }

    const poolForca = rewardVaultConfig.poolForcaReserve;
    const poolSol = rewardVaultConfig.poolSolReserve;
    if (!poolForca || !poolSol) {
      throw new Error('Pool reserve addresses missing (set VITE_REWARD_VAULT_POOL_FORCA_RESERVE / POOL_SOL_RESERVE)');
    }

    const [forcaReserve, solReserve] = await Promise.all([
      getAccount(connection, poolForca),
      getAccount(connection, poolSol),
    ]);
    if (solReserve.amount === 0n) throw new Error('SOL reserve account is empty');
    const forcaPerSolE6 = (forcaReserve.amount * WSOL_SCALE) / solReserve.amount;
    if (forcaPerSolE6 === 0n) throw new Error('Derived FORCA/SOL ratio is zero');

    let solPriceUsdE6: bigint;
    if (vault.verifyPrices) {
      solPriceUsdE6 = await fetchSolPriceUsdE6FromFeed(vault.pythSolUsdPriceFeed, vault.pythMaxConfidenceBps);
    } else if (vault.forcaUsdE6 > 0n) {
      solPriceUsdE6 = (vault.forcaUsdE6 * forcaPerSolE6) / MICRO_SCALE;
    } else {
      const fallbackFeed = rewardVaultConfig.pythPriceFeedAccount ?? vault.pythSolUsdPriceFeed;
      if (!fallbackFeed) throw new Error('Vault FORCA/USD price not configured');
      solPriceUsdE6 = await fetchSolPriceUsdE6FromFeed(fallbackFeed, vault.pythMaxConfidenceBps);
    }

    return { solPriceUsdE6, forcaPerSolE6 };
  };

  const handleConvertInputChange = (allyMint: string, next: string) => {
    updateActionState(allyMint, (prev) => ({
      ...prev,
      convertAmount: next,
      convertMessage: null,
      convertStatus: prev.convertStatus === 'pending' ? prev.convertStatus : 'idle',
    }));
  };

  const handleClaimInputChange = (allyMint: string, next: string) => {
    updateActionState(allyMint, (prev) => ({
      ...prev,
      claimAmount: next,
      claimMessage: null,
      claimStatus: prev.claimStatus === 'pending' ? prev.claimStatus : 'idle',
    }));
  };

  const handleConvertMax = (allyMint: string) => {
    if (!forcaTokenBalance) return;
    const decimals = Number(forcaTokenBalance.decimals ?? FORCA_DECIMALS);
    const amount = parseDecimalAmount(forcaTokenBalance.uiAmountString, decimals);
    if (amount === null) return;
    const formatted = formatBigintToInput(amount, decimals);
    updateActionState(allyMint, (prev) => ({
      ...prev,
      convertAmount: formatted,
      convertMessage: null,
      convertStatus: prev.convertStatus === 'pending' ? prev.convertStatus : 'idle',
    }));
  };

  const handleClaimMax = (allyMint: string, ledger: UserLedgerData) => {
    if (!ledger.rpClaimable || ledger.rpClaimable === 0n) return;
    const formatted = formatBigintToInput(ledger.rpClaimable, FORCA_DECIMALS);
    updateActionState(allyMint, (prev) => ({
      ...prev,
      claimAmount: formatted,
      claimMessage: null,
      claimStatus: prev.claimStatus === 'pending' ? prev.claimStatus : 'idle',
    }));
  };

  const handleConvertSubmit = async (ledger: UserLedgerData) => {
    const allyMintStr = ledger.ally.mintAddress;
    const state = getActionState(allyMintStr);
    const amount = parseDecimalAmount(state.convertAmount, FORCA_DECIMALS);
    pushConvertDebug(allyMintStr, 'Start Convert');
    try { if (publicKey) pushConvertDebug(allyMintStr, `Wallet: ${publicKey.toBase58()}`); } catch {}
    try { if (forcaMint) pushConvertDebug(allyMintStr, `Env FORCA_MINT: ${forcaMint}`); } catch {}
    if (amount === null || amount === 0n) {
      pushConvertDebug(allyMintStr, 'Invalid amount');
      updateActionState(allyMintStr, (prev) => ({
        ...prev,
        convertStatus: 'error',
        convertMessage: '❌ Enter a valid amount (> 0)',
      }));
      return;
    }
    if (!publicKey) {
      pushConvertDebug(allyMintStr, 'No wallet connected');
      updateActionState(allyMintStr, (prev) => ({
        ...prev,
        convertStatus: 'error',
        convertMessage: '❌ Connect wallet first',
      }));
      return;
    }

    updateActionState(allyMintStr, (prev) => ({
      ...prev,
      convertStatus: 'pending',
      convertMessage: null,
      convertTxSig: null,
    }));

    try {
      pushConvertDebug(allyMintStr, 'Loading vault state');
      const vault = await ensureVaultState();
      try {
        pushConvertDebug(allyMintStr, `Vault: ${vault.address.toBase58()} Program: ${rewardProgramId}`);
        pushConvertDebug(allyMintStr, `Vault FORCA mint: ${vault.forcaMint.toBase58()}`);
      } catch {}
      if (vault.paused) throw new Error('Vault is currently paused');
      if (!vault.verifyPrices) {
        throw new Error('verify_prices is disabled. Ask admin to enable oracle verification before converting.');
      }
      const allyMint = new PublicKey(allyMintStr);
      const allyAcc = await ensureAllyAccount(allyMint);
      pushConvertDebug(allyMintStr, 'Ally account ready');
      try {
        pushConvertDebug(allyMintStr, `Ally address: ${allyAcc.address.toBase58()}`);
        pushConvertDebug(allyMintStr, `Ally NFT mint: ${allyAcc.nftMint.toBase58()}`);
        pushConvertDebug(allyMintStr, `Ally vault ATA: ${allyAcc.vaultAta.toBase58()}`);
      } catch {}
      if (vault.verifyPrices && !vault.useMockOracle) {
        pushConvertDebug(allyMintStr, 'Verify price dependencies');
        if (vault.pythSolUsdPriceFeed.equals(PublicKey.default)) {
          throw new Error('Vault Pyth SOL/USD feed not configured');
        }
        if (vault.canonicalPoolForcaSol.equals(PublicKey.default)) {
          throw new Error('Vault canonical pool not configured');
        }
        if (!rewardVaultConfig.poolForcaReserve || !rewardVaultConfig.poolSolReserve) {
          throw new Error('Set VITE_REWARD_VAULT_POOL_FORCA_RESERVE / POOL_SOL_RESERVE in .env');
        }
      }
      const { oracleAddress, poolAddress, oracleAccount, poolAccount } = await ensureMockAccounts();
      if (!vault.useMockOracle && (!oracleAccount || !poolAccount)) {
        throw new Error('Mock oracle PDAs are not initialized; ask admin to run setMockOracles once.');
      }

      const userAta = await getAssociatedTokenAddress(
        vault.forcaMint,
        publicKey,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );

      const instructions = [];
      try { pushConvertDebug(allyMintStr, `Using token program: ${TOKEN_PROGRAM_ID.toBase58()}`); } catch {}
      const ataInfo = await connection.getAccountInfo(userAta, 'confirmed');
      try { pushConvertDebug(allyMintStr, `Derived user ATA: ${userAta.toBase58()}`); } catch {}
      if (!ataInfo) {
        pushConvertDebug(allyMintStr, 'Create user ATA');
        instructions.push(
          createAssociatedTokenAccountInstruction(
            publicKey,
            userAta,
            publicKey,
            vault.forcaMint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID,
          ),
        );
      } else {
        pushConvertDebug(allyMintStr, 'User ATA exists');
        const balanceInfo = await connection.getTokenAccountBalance(userAta).catch(() => null);
        const available = balanceInfo ? BigInt(balanceInfo.value.amount) : 0n;
        if (amount > available) throw new Error('Insufficient $FORCA balance');
      }

      pushConvertDebug(allyMintStr, 'Fetching quote');
      const quote = await fetchQuote(vault);
      try { pushConvertDebug(allyMintStr, `Quote solPriceUsdE6=${quote.solPriceUsdE6.toString()} forcaPerSolE6=${quote.forcaPerSolE6.toString()}`);} catch {}
      const userLedger = deriveUserLedgerPda(rewardVaultConfig.programId, publicKey, allyMint);
      try { pushConvertDebug(allyMintStr, `UserLedger: ${userLedger.toBase58()}`);} catch {}

      const poolForcaReserveKey = rewardVaultConfig.poolForcaReserve ?? allyAcc.vaultAta;
      const poolSolReserveKey = rewardVaultConfig.poolSolReserve;
      if (!poolSolReserveKey) throw new Error('Pool SOL reserve address not configured');

      const convertIx = createConvertToScopedPPIx({
        programId: rewardVaultConfig.programId,
        accounts: {
          user: publicKey,
          userAta,
          vaultState: vault.address,
          ally: allyAcc.address,
          nftMint: allyAcc.nftMint,
          allyVaultAta: allyAcc.vaultAta,
          userLedger,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          pythSolUsdPriceFeed: vault.pythSolUsdPriceFeed,
          canonicalPoolForcaSol: vault.canonicalPoolForcaSol,
          mockOracleSol: oracleAddress,
          mockPoolForca: poolAddress,
          poolForcaReserve: poolForcaReserveKey,
          poolSolReserve: poolSolReserveKey,
        },
        amountForca: amount,
        solPriceUsdE6: quote.solPriceUsdE6,
        forcaPerSolE6: quote.forcaPerSolE6,
      });
      try {
        pushConvertDebug(allyMintStr, `Pyth feed: ${vault.pythSolUsdPriceFeed.toBase58()}`);
        pushConvertDebug(allyMintStr, `Canonical pool: ${vault.canonicalPoolForcaSol.toBase58()}`);
        pushConvertDebug(allyMintStr, `Pool reserves: FORCA=${poolForcaReserveKey.toBase58()} SOL=${poolSolReserveKey.toBase58()}`);
      } catch {}
      instructions.push(convertIx);

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('processed');
      const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash });
      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: tipFor(0) }),
      );
      for (const ix of instructions) {
        tx.add(ix);
      }
      pushConvertDebug(allyMintStr, 'Simulating transaction');
      const simTx = VersionedTransaction.deserialize(
        tx.serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        }),
      );
      const simulation = await connection.simulateTransaction(simTx, {
        commitment: 'processed',
      });
      try {
        if (Array.isArray(simulation.value.logs)) {
          for (const ln of simulation.value.logs) pushConvertDebug(allyMintStr, `log: ${ln}`);
        }
      } catch {}
      if (simulation.value.err) {
        const friendly = extractFriendlyError({ logs: simulation.value.logs ?? [] });
        try { pushConvertDebug(allyMintStr, `sim.err: ${JSON.stringify(simulation.value.err)}`); } catch {}
        throw new Error(friendly || JSON.stringify(simulation.value.err));
      }

      pushConvertDebug(allyMintStr, 'Sending transaction');
      const sig = await sendTransaction(tx, connection, {
        skipPreflight: true,
        preflightCommitment: 'processed',
      });

      pushConvertDebug(allyMintStr, `Submitted: ${sig}`);
      await waitForConfirmationPoll(connection, sig, lastValidBlockHeight, 60_000, 600);
      pushConvertDebug(allyMintStr, 'Confirmed');
      const shortSig = `${sig.slice(0, 4)}…${sig.slice(-4)}`;
      updateActionState(allyMintStr, (prev) => ({
        ...prev,
        convertStatus: 'success',
        convertMessage: `✅ ${shortSig}`,
        convertTxSig: sig,
        convertAmount: '',
      }));
      // Report activity for Quest6
      reportActivity({ type: 'reward_vault_convert', txid: sig, quest_id: 'quest6_reward_vault' });
          setSnapshotReloadNonce((n) => n + 1);
          setQuoteInfo((prev) =>
            prev
              ? {
                  ...prev,
                  updatedAt: Date.now(),
                }
              : prev,
          );
          const refreshed = await fetchAllyAccount(connection, rewardVaultConfig.programId, allyMint, 'processed').catch(() => null);
          if (refreshed) {
            pushConvertDebug(allyMintStr, 'Ally account refreshed');
            setAllyAccountMap((prev) => ({ ...prev, [allyMintStr]: refreshed }));
          }
    } catch (err: any) {
      const message = extractFriendlyError(err);
      const logs = extractProgramLogs(err);
      if (logs) console.error('convert logs', logs);
      else console.error('convert error', err);
      pushConvertDebug(allyMintStr, `Error: ${message}`);
      updateActionState(allyMintStr, (prev) => ({
        ...prev,
        convertStatus: 'error',
        convertMessage: `❌ ${message}`,
        convertTxSig: null,
      }));
    } finally {
      updateActionState(allyMintStr, (prev) => {
        if (prev.convertStatus === 'pending') {
          return { ...prev, convertStatus: 'idle' };
        }
        return prev;
      });
    }
  };

  const handleClaimSubmit = async (ledger: UserLedgerData) => {
    const allyMintStr = ledger.ally.mintAddress;
    const state = getActionState(allyMintStr);
    const amount = parseDecimalAmount(state.claimAmount, FORCA_DECIMALS);
    pushClaimDebug(allyMintStr, 'Start Claim');
    try { if (publicKey) pushClaimDebug(allyMintStr, `Wallet: ${publicKey.toBase58()}`); } catch {}
    try { if (forcaMint) pushClaimDebug(allyMintStr, `Env FORCA_MINT: ${forcaMint}`); } catch {}
    if (amount === null || amount === 0n) {
      pushClaimDebug(allyMintStr, 'Invalid amount');
      updateActionState(allyMintStr, (prev) => ({
        ...prev,
        claimStatus: 'error',
        claimMessage: '❌ Enter a valid amount (> 0)',
      }));
      return;
    }
    if (amount > ledger.rpClaimable) {
      pushClaimDebug(allyMintStr, 'Amount exceeds claimable');
      updateActionState(allyMintStr, (prev) => ({
        ...prev,
        claimStatus: 'error',
        claimMessage: '❌ Amount exceeds claimable RP',
      }));
      return;
    }
    if (!publicKey) {
      pushClaimDebug(allyMintStr, 'No wallet connected');
      updateActionState(allyMintStr, (prev) => ({
        ...prev,
        claimStatus: 'error',
        claimMessage: '❌ Connect wallet first',
      }));
      return;
    }

    updateActionState(allyMintStr, (prev) => ({
      ...prev,
      claimStatus: 'pending',
      claimMessage: null,
      claimTxSig: null,
    }));

    try {
      pushClaimDebug(allyMintStr, 'Loading vault state');
      const vault = await ensureVaultState();
      const allyMint = new PublicKey(allyMintStr);
      const allyAcc = await ensureAllyAccount(allyMint);
      pushClaimDebug(allyMintStr, 'Ally account ready');
      try {
        pushClaimDebug(allyMintStr, `Vault: ${vault.address.toBase58()} Program: ${rewardProgramId}`);
        pushClaimDebug(allyMintStr, `Vault FORCA mint: ${vault.forcaMint.toBase58()}`);
        pushClaimDebug(allyMintStr, `Ally address: ${allyAcc.address.toBase58()}`);
        pushClaimDebug(allyMintStr, `Ally NFT mint: ${allyAcc.nftMint.toBase58()}`);
        pushClaimDebug(allyMintStr, `Ally vault ATA: ${allyAcc.vaultAta.toBase58()}`);
      } catch {}
      if (vault.verifyPrices && !vault.useMockOracle) {
        if (vault.pythSolUsdPriceFeed.equals(PublicKey.default)) {
          throw new Error('Vault Pyth SOL/USD feed not configured');
        }
        if (vault.canonicalPoolForcaSol.equals(PublicKey.default)) {
          throw new Error('Vault canonical pool not configured');
        }
        if (!rewardVaultConfig.poolForcaReserve || !rewardVaultConfig.poolSolReserve) {
          throw new Error('Set VITE_REWARD_VAULT_POOL_FORCA_RESERVE / POOL_SOL_RESERVE in .env');
        }
      }
      const { oracleAddress, poolAddress, oracleAccount, poolAccount } = await ensureMockAccounts();
      if (!vault.useMockOracle && (!oracleAccount || !poolAccount)) {
        throw new Error('Mock oracle PDAs are not initialized; ask admin to run setMockOracles once.');
      }

      const userAta = await getAssociatedTokenAddress(
        vault.forcaMint,
        publicKey,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const instructions = [];
      try { pushClaimDebug(allyMintStr, `Using token program: ${TOKEN_PROGRAM_ID.toBase58()}`); } catch {}
      const ataInfo = await connection.getAccountInfo(userAta, 'confirmed');
      try { pushClaimDebug(allyMintStr, `Derived user ATA: ${userAta.toBase58()}`); } catch {}
      if (!ataInfo) {
        pushClaimDebug(allyMintStr, 'Create user ATA');
        instructions.push(
          createAssociatedTokenAccountInstruction(
            publicKey,
            userAta,
            publicKey,
            vault.forcaMint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID,
          ),
        );
      } else {
        pushClaimDebug(allyMintStr, 'User ATA exists');
      }

      const userLedger = deriveUserLedgerPda(rewardVaultConfig.programId, publicKey, allyMint);
      const popProfile = derivePopProfilePda(rewardVaultConfig.programId, publicKey);
      const claimGuard = deriveClaimGuardPda(rewardVaultConfig.programId, publicKey, allyMint);
      const vaultSigner = deriveVaultSignerPda(rewardVaultConfig.programId);
      const pythSolUsdPriceFeed = vault.pythSolUsdPriceFeed.equals(PublicKey.default)
        ? vault.address
        : vault.pythSolUsdPriceFeed;
      const canonicalPoolForcaSol = vault.canonicalPoolForcaSol.equals(PublicKey.default)
        ? vault.address
        : vault.canonicalPoolForcaSol;
      const poolForcaReserveKey = rewardVaultConfig.poolForcaReserve ?? allyAcc.vaultAta;
      const poolSolReserveKey = rewardVaultConfig.poolSolReserve ?? userAta;
      try {
        pushClaimDebug(allyMintStr, `UserLedger: ${userLedger.toBase58()}`);
        pushClaimDebug(allyMintStr, `PopProfile: ${popProfile.toBase58()}`);
        pushClaimDebug(allyMintStr, `ClaimGuard: ${claimGuard.toBase58()}`);
        pushClaimDebug(allyMintStr, `VaultSigner: ${vaultSigner.toBase58()}`);
        pushClaimDebug(allyMintStr, `Pyth feed: ${pythSolUsdPriceFeed.toBase58()}`);
        pushClaimDebug(allyMintStr, `Canonical pool: ${canonicalPoolForcaSol.toBase58()}`);
        pushClaimDebug(allyMintStr, `Pool reserves: FORCA=${poolForcaReserveKey.toBase58()} SOL=${poolSolReserveKey.toBase58()}`);
      } catch {}

      const claimIx = createClaimRPIx({
        programId: rewardVaultConfig.programId,
        accounts: {
          user: publicKey,
          userAta,
          ally: allyAcc.address,
          vaultState: vault.address,
          vaultSigner,
          allyVaultAta: allyAcc.vaultAta,
          userLedger,
          tokenProgram: TOKEN_PROGRAM_ID,
          popProfile,
          claimGuard,
          pythSolUsdPriceFeed,
          canonicalPoolForcaSol,
          mockOracleSol: oracleAddress,
          mockPoolForca: poolAddress,
          poolForcaReserve: poolForcaReserveKey,
          poolSolReserve: poolSolReserveKey,
          systemProgram: SystemProgram.programId,
        },
        amountForca: amount,
      });
      instructions.push(claimIx);

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('processed');
      const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash });
      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: tipFor(0) }),
      );
      for (const ix of instructions) {
        tx.add(ix);
      }
      pushClaimDebug(allyMintStr, 'Simulating transaction');
      const simTx = VersionedTransaction.deserialize(
        tx.serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        }),
      );
      const simulation = await connection.simulateTransaction(simTx, {
        commitment: 'processed',
      });
      try {
        if (Array.isArray(simulation.value.logs)) {
          for (const ln of simulation.value.logs) pushClaimDebug(allyMintStr, `log: ${ln}`);
        }
      } catch {}
      if (simulation.value.err) {
        const friendly = extractFriendlyError({ logs: simulation.value.logs ?? [] });
        try { pushClaimDebug(allyMintStr, `sim.err: ${JSON.stringify(simulation.value.err)}`); } catch {}
        throw new Error(friendly || JSON.stringify(simulation.value.err));
      }

      pushClaimDebug(allyMintStr, 'Sending transaction');
      const sig = await sendTransaction(tx, connection, {
        skipPreflight: true,
        preflightCommitment: 'processed',
      });

      pushClaimDebug(allyMintStr, `Submitted: ${sig}`);
      await waitForConfirmationPoll(connection, sig, lastValidBlockHeight, 60_000, 600);
      pushClaimDebug(allyMintStr, 'Confirmed');
      const shortSig = `${sig.slice(0, 4)}…${sig.slice(-4)}`;
      updateActionState(allyMintStr, (prev) => ({
        ...prev,
        claimStatus: 'success',
        claimMessage: `✅ ${shortSig}`,
        claimTxSig: sig,
        claimAmount: '',
      }));
      // Report activity for Quest6
      reportActivity({ type: 'reward_vault_claim', txid: sig, quest_id: 'quest6_reward_vault' });
      setSnapshotReloadNonce((n) => n + 1);
      const refreshed = await fetchAllyAccount(connection, rewardVaultConfig.programId, allyMint, 'processed').catch(() => null);
      if (refreshed) {
        pushClaimDebug(allyMintStr, 'Ally account refreshed');
        setAllyAccountMap((prev) => ({ ...prev, [allyMintStr]: refreshed }));
      }
    } catch (err: any) {
      const message = extractFriendlyError(err);
      const logs = extractProgramLogs(err);
      if (logs) console.error('claim logs', logs);
      else console.error('claim error', err);
      pushClaimDebug(allyMintStr, `Error: ${message}`);
      updateActionState(allyMintStr, (prev) => ({
        ...prev,
        claimStatus: 'error',
        claimMessage: `❌ ${message}`,
        claimTxSig: null,
      }));
    } finally {
      updateActionState(allyMintStr, (prev) => {
        if (prev.claimStatus === 'pending') {
          return { ...prev, claimStatus: 'idle' };
        }
        return prev;
      });
    }
  };


  // 기존 핸들러 제거: 공통 오버레이가 지갑 선택 및 QR 처리까지 수행

  // 1) 최신 SIWS 경로 (지갑이 signIn 기능을 제공하면 우선 사용)
  const handleSIWS = async () => {
    // ① 입력 생성(백엔드)
    const input: SolanaSignInInput = await fetch('/api/siws/create').then(r => r.json());

    const adapter = wallet?.adapter;
    if (hasSignIn(adapter)) {
      // ② 표준 SIWS (지갑이 지원할 때)
      const output = await adapter.signIn(input);
      const toB64 = (u8: Uint8Array) => btoa(String.fromCharCode(...u8));
      const addr = (output as any)?.account?.address || publicKey?.toBase58();
      const payload = {
        input,
        publicKey: addr,
        output: {
          ...output,
          signedMessage: toB64(output.signedMessage),
          signature: toB64(output.signature),
        },
      };
      const ok = await fetch('/api/siws/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      }).then(r => r.ok);
      if (ok) {
        const tok = await exchangeJwt();
        if (tok) {
          pushToast('Wallet signature verified and JWT ready.', { type: 'success', title: 'Signed in (SIWS)', source: 'auth' });
        } else {
          pushToast('Signature completed but JWT exchange failed. Please try again.', { type: 'warning', title: 'JWT exchange failed', source: 'auth' });
        }
      } else {
        pushToast('SIWS verification failed. Please try again.', { type: 'error', title: 'Sign-In failed', source: 'auth' });
      }
    } else {
      // ③ 폴백: 레거시 signMessage
      await handleLegacySignIn();
    }
  };

  // 2) 레거시 nonce 메시지 서명 (fallback)
  const handleLegacySignIn = async () => {
    if (!signMessage || !publicKey) {
      pushToast('This wallet does not support signMessage.', { type: 'error', title: 'Sign message not supported', source: 'auth' });
      return;
    }
    const { nonce, message } = await fetch('/api/auth/nonce').then(r => r.json());
    const signature = await signMessage(new TextEncoder().encode(message));
    const toBase64 = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes));
    const sigB64 = toBase64(signature);

    const ok = await fetch('/api/auth/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        publicKey: publicKey.toBase58(),
        signature: sigB64,
        nonce
      })
    }).then(r => r.ok);
    if (ok) {
      const tok = await exchangeJwt();
      if (tok) {
        pushToast('Signature verified and JWT ready.', { type: 'success', title: 'Signed in', source: 'auth' });
      } else {
        pushToast('Signature completed but JWT exchange failed. Please try again.', { type: 'warning', title: 'JWT exchange failed', source: 'auth' });
      }
    } else {
      pushToast('Signature verification failed. Please try again.', { type: 'error', title: 'Sign-In failed', source: 'auth' });
    }
  };

  // 3) 트랜잭션 예제: 자기 자신에게 1 lamport 전송
  const handleTx = async () => {
    if (!publicKey) return;

    const adapter = wallet?.adapter as Adapter | undefined;

    for (let attempt = 0; attempt < 3; attempt++) {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('processed');

      const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash }).add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: tipFor(attempt) }),
        SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: publicKey, lamports: 1 }),
      );

      try {
        if (adapter && (adapter as any).signTransaction) {
          // Manual sign + aggressive rebroadcast
          const { sig, stop } = await signAndSendWithRebroadcast(connection, adapter, tx, 400);
          try {
            await waitForConfirmationPoll(connection, sig, lastValidBlockHeight, 60_000, 600);
            console.log('✅ confirmed', sig);
            stop();
            break; // success
          } catch (e) {
            stop();
            if (String(e).includes('Blockhash expired')) {
              console.warn('blockhash expired → 재전송 시도', attempt + 1);
              continue; // new blockhash + higher tip
            }
            throw e;
          }
        } else {
          // Fallback: adapter-managed sendTransaction; make it as fast as possible
          const sig = await sendTransaction(tx, connection, {
            skipPreflight: true,
            preflightCommitment: 'processed',
            maxRetries: 0,
          });
          await waitForConfirmationPoll(connection, sig, lastValidBlockHeight, 60_000, 600);
          console.log('✅ confirmed', sig);
          break;
        }
      } catch (e) {
        if (String(e).includes('Blockhash expired')) {
          console.warn('blockhash expired → 재전송 시도', attempt + 1);
          continue;
        }
        throw e;
      }
    }
  };

  const totalRpClaimable = useMemo(() => {
    return rewardSnapshot?.ledgers?.reduce((acc, ledger) => acc + ledger.rpClaimable, 0n) ?? 0n;
  }, [rewardSnapshot]);

  const totalPpBalance = useMemo(() => {
    return rewardSnapshot?.ledgers?.reduce((acc, ledger) => acc + ledger.ppBalance, 0n) ?? 0n;
  }, [rewardSnapshot]);

  // 컨텍스트 캐시를 최신 상태로 유지 (탭을 방문하지 않아도 최신 데이터 보냄)
  useEffect(() => {
    buildQuestsContext();
  }, [quests, availableQuests, questDefs, questRewardStates, official]);

  useEffect(() => {
    buildSnapshotContext();
  }, [rewardSnapshot, quoteInfo, sol, vaultStateAccount]);

  useEffect(() => {
    buildShopContext();
  }, [totalPpBalance, chatQuota, shopItems, donateAmount, donateNote, donateMsg, chatBuyMsg, chatBuyBusy]);

  const getPopCapInfo = useCallback(
    (allyMint?: string | null) => {
      if (!allyMint || !vaultStateAccount || vaultStateAccount.forcaUsdE6 <= 0n) return null;
      const allyAccount = allyAccountMap[allyMint] ?? null;
      if (!allyAccount) return null;
      const capUsd = allyAccount.softDailyCapUsdE6;
      if (capUsd <= 0n) return null;
      const capForca = (capUsd * MICRO_SCALE) / vaultStateAccount.forcaUsdE6;
      return {
        capUsd,
        capForca,
        cooldownSecs: allyAccount.softCooldownSecs,
        popEnforced: allyAccount.popEnforced,
      };
    },
    [allyAccountMap, vaultStateAccount],
  );

  const popLevelIndex = rewardSnapshot?.popProfile?.levelIndex ?? null;
  const popAllocateAllowed = popLevelIndex === 1 || popLevelIndex === 2;
  const quest4Status = quest4Doc?.status;
  const quest4ReadyForClaim = quest4Status === 'completed';
  const quest4RewardGranted = quest4Status === 'rewarded' || questRewardStates['quest4_pop_uniq']?.status === 'success';

  const openSnapshotWithFocus = useCallback(
    (allyMint: string, action: 'claim' | 'convert', { forceReload }: { forceReload?: boolean } = {}) => {
      const now = Date.now();
      const freshThresholdMs = 8000;
      const isFresh =
        !forceReload &&
        snapshotFetchedAtRef.current !== null &&
        now - snapshotFetchedAtRef.current < freshThresholdMs &&
        !rewardLoading;
      if (!isFresh) {
        setSnapshotReloadNonce((n) => n + 1);
      }
      setCurrentTab('snapshot');
      setSnapshotFocus({ allyMint, action });
    },
    [rewardLoading],
  );

  const walletForcaAmount = useMemo(() => {
    if (!forcaTokenBalance) return 0n;
    const decimals = Number(forcaTokenBalance.decimals ?? FORCA_DECIMALS);
    return parseDecimalAmount(forcaTokenBalance.uiAmountString, decimals) ?? 0n;
  }, [forcaTokenBalance]);

  const bestClaimLedger = useMemo<UserLedgerData | null>(() => {
    const ledgers = rewardSnapshot?.ledgers ?? [];
    const claimable = ledgers.filter((l) => l.rpClaimable > 0n);
    if (claimable.length === 0) return null;
    return claimable.reduce((best, cur) => (cur.rpClaimable > best.rpClaimable ? cur : best), claimable[0]);
  }, [rewardSnapshot]);

  const convertTargetLedger = useMemo<UserLedgerData | null>(() => {
    if (!forcaTokenBalance || walletForcaAmount <= 0n) return null;
    const ledgers = rewardSnapshot?.ledgers ?? [];
    if (ledgers.length === 0) return null;
    return ledgers.find((l) => l.exists) ?? ledgers[0];
  }, [forcaTokenBalance, rewardSnapshot, walletForcaAmount]);

  const popParamsAlly = useMemo(() => {
    if (bestClaimLedger) return bestClaimLedger.ally;
    const first = rewardSnapshot?.ledgers?.[0]?.ally ?? null;
    return first ?? null;
  }, [bestClaimLedger, rewardSnapshot]);
  const popParamsInfo = useMemo(
    () => getPopCapInfo(popParamsAlly?.mintAddress ?? null),
    [getPopCapInfo, popParamsAlly],
  );

  const computeEffectiveClaimable = useCallback(
    (ledger: UserLedgerData) => {
      const allyAccount = allyAccountMap[ledger.ally.mintAddress] ?? null;
      const guardApplies = Boolean(allyAccount?.popEnforced) && popLevelIndex !== 2;
      if (!guardApplies) {
        return { effectiveClaimable: ledger.rpClaimable, remainingUsd: null, remainingForca: null };
      }
      const capInfo = getPopCapInfo(ledger.ally.mintAddress);
      const guard = rewardSnapshot?.claimGuards?.[ledger.ally.mintAddress];
      const nowDay = Math.floor(Date.now() / 1000 / 86_400);
      const guardDay = guard && guard.day !== null && guard.day !== undefined ? Number(guard.day) : null;
      const usedUsdToday = guard && guard.exists && guardDay === nowDay ? guard.usedUsdE6 : 0n;
      const remainingUsd =
        capInfo && capInfo.capUsd > usedUsdToday ? capInfo.capUsd - usedUsdToday : capInfo ? 0n : null;
      const remainingForca =
        remainingUsd !== null ? (remainingUsd * MICRO_SCALE) / vaultStateAccount!.forcaUsdE6 : null;
      const effectiveClaimable =
        remainingForca !== null ? (ledger.rpClaimable < remainingForca ? ledger.rpClaimable : remainingForca) : ledger.rpClaimable;
      return { effectiveClaimable, remainingUsd, remainingForca };
    },
    [allyAccountMap, getPopCapInfo, popLevelIndex, rewardSnapshot?.claimGuards, vaultStateAccount],
  );

  const setClaimPrefill = useCallback(
    (allyMint: string, amount: bigint) => {
      const formatted = amount > 0n ? formatBigintToInput(amount, FORCA_DECIMALS) : '';
      updateActionState(allyMint, (prev) => ({
        ...prev,
        claimAmount: formatted,
        claimMessage: null,
        claimStatus: prev.claimStatus === 'pending' ? prev.claimStatus : 'idle',
      }));
    },
    [updateActionState],
  );

  // removed unused acceptedQuestIds

  const outstandingQuests = useMemo(() => availableQuests, [availableQuests]);

  const assistantCards = useMemo(() => {
    if (!jwtToken) {
      return [
        <div className="assistant-card" key="auth">
          <h4>Sign-In to continue</h4>
          <div className="assistant-meta">Wallet authorization unlocks RP, PP, and quest actions.</div>
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            <button className="assistant-btn" type="button" onClick={handleSIWS}>Sign-In with Solana</button>
            <button className="assistant-btn secondary" type="button" onClick={handleLegacySignIn}>Legacy Sign-In</button>
          </div>
        </div>,
      ];
    }

    const cards: ReactNode[] = [];

    const quest = outstandingQuests[0];
    const claimCandidate = (() => {
      if (!bestClaimLedger) return null;
      const { effectiveClaimable } = computeEffectiveClaimable(bestClaimLedger);
      if (effectiveClaimable <= 0n) return null;
      return { ledger: bestClaimLedger, effectiveClaimable };
    })();

    if (quest) {
      const accepting = questAccepting === quest.quest_id;
      cards.push(
        <div className="assistant-card" key={`quest-${quest.quest_id}`}>
          <h4>Next quest · {quest.title}</h4>
          <div className="assistant-subtle">Reward: {quest.reward_label || (typeof (quest as any).reward_rp === 'number' && (quest as any).reward_rp > 0 ? `+${(quest as any).reward_rp} RP` : (normalizePopLabel((quest as any).reward_pop) ? `PoP Level: ${normalizePopLabel((quest as any).reward_pop)}` : ''))}</div>
          <div className="assistant-subtle" style={{ marginTop: 4 }}>
            Accepting jumps you to Quests and highlights this task so you can finish it right away.
          </div>
          <div className="actions">
            <button className="assistant-btn" type="button" disabled={accepting} onClick={() => acceptQuest(quest.quest_id)}>
              {accepting ? 'Accepting…' : 'Accept & follow'}
            </button>
            <button className="assistant-btn secondary" type="button" onClick={() => setCurrentTab('quests')}>View all quests</button>
          </div>
        </div>
      );
    } else if (claimCandidate) {
      const { ledger, effectiveClaimable } = claimCandidate;
      const allyLabel = ledger.ally.label;
      const claimableText = formatAmount(effectiveClaimable, FORCA_DECIMALS, 'RP');
      const goClaim = () => {
        const targetAmount = effectiveClaimable > 0n ? effectiveClaimable : ledger.rpClaimable;
        setClaimPrefill(ledger.ally.mintAddress, targetAmount);
        openSnapshotWithFocus(ledger.ally.mintAddress, 'claim');
      };
      cards.push(
        <div className="assistant-card" key="claim-suggestion">
          <h4>Claim RP ready</h4>
          <div className="assistant-meta">
            {`You can claim ${claimableText} from ${allyLabel}.`}
          </div>
          <div className="assistant-subtle" style={{ marginTop: 4 }}>
            We’ll open Snapshot, set Max for you, and highlight the Claim area.
          </div>
          <div className="actions">
            <button className="assistant-btn" type="button" onClick={goClaim}>
              Prefill & review
            </button>
            <button className="assistant-btn secondary" type="button" onClick={() => setCurrentTab('snapshot')}>
              Just open Snapshot
            </button>
          </div>
        </div>
      );
    } else if (convertTargetLedger && walletForcaAmount > 0n) {
      const allyLabel = convertTargetLedger.ally.label;
      const walletForcaText = forcaTokenBalance
        ? formatAmount(walletForcaAmount, Number(forcaTokenBalance.decimals ?? FORCA_DECIMALS), '$FORCA')
        : `${walletForcaAmount.toString()} $FORCA`;
      const goConvert = () => {
        handleConvertMax(convertTargetLedger.ally.mintAddress);
        openSnapshotWithFocus(convertTargetLedger.ally.mintAddress, 'convert');
      };
      cards.push(
        <div className="assistant-card" key="convert-suggestion">
          <h4>Convert $FORCA → PP</h4>
          <div className="assistant-meta">
            {`Wallet available for ${allyLabel}: ${walletForcaText}. Convert now to receive PP.`}
          </div>
          <div className="assistant-subtle" style={{ marginTop: 4 }}>
            We’ll jump to Snapshot, prefill the Max amount, and spotlight the Convert form.
          </div>
          <div className="actions">
            <button className="assistant-btn" type="button" onClick={goConvert}>
              Prefill & review
            </button>
            <button className="assistant-btn secondary" type="button" onClick={() => setCurrentTab('snapshot')}>
              Just open Snapshot
            </button>
          </div>
        </div>
      );
    }

    return cards.slice(0, 1);
  }, [
    acceptQuest,
    bestClaimLedger,
    computeEffectiveClaimable,
    convertTargetLedger,
    forcaTokenBalance,
    handleLegacySignIn,
    handleSIWS,
    handleConvertMax,
    setClaimPrefill,
    jwtToken,
    outstandingQuests,
    questAccepting,
    setCurrentTab,
    openSnapshotWithFocus,
    walletForcaAmount,
  ]);


  // --- Environment detection for primary action (Browse vs Connect) ---
  const [env, setEnv] = useState({
    isMobile: /iPhone|iPad|iPod|Android/i.test(navigator.userAgent),
    isIOS: /iPhone|iPad|iPod/i.test(navigator.userAgent),
    isSafari: /Safari/i.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/i.test(navigator.userAgent),
    inAppWalletUA: /(Phantom|Solflare|Backpack|MetaMask|MetaMaskMobile|TrustWallet|Trust|Bitget|Exodus)/i.test(navigator.userAgent) || /metamask\.app\.link|trustwallet|bitget|exodus/i.test(document.referrer || ''),
    hasInjectedProvider: false,
  });

  const walletAnchorRef = useRef<HTMLDivElement>(null);
  const handleWalletButtonClick = useCallback(() => {
    anchorRewardDropdown(walletAnchorRef.current?.getBoundingClientRect() ?? undefined);
  }, []);

  useEffect(() => {
    return () => {
      clearRewardDropdownAnchor();
    };
  }, []);

  useEffect(() => {
    if (!connected) {
      clearRewardDropdownAnchor();
    }
  }, [connected]);

  useEffect(() => {
    const w: any = window as any;
    const injected = !!(
      (w.solana && (w.solana.isPhantom || w.solana.isSolflare || w.solana.isBackpack)) ||
      (w.phantom && w.phantom.solana) ||
      (w.backpack && w.backpack.solana)
    );
    setEnv((e) => ({ ...e, hasInjectedProvider: injected }));
  }, []);

  useEffect(() => {
    if (!recentlyAcceptedQuestId || currentTab !== 'quests') return;
    const el = questCardRefs.current[recentlyAcceptedQuestId];
    if (el?.scrollIntoView) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [recentlyAcceptedQuestId, currentTab, quests]);

  // 조건 변경: iOS & (지갑 in-app 아님) 이면 Browse 우선 (Safari 여부/InjectedProvider 무관)
  const primaryIsBrowse =
    !connected &&
    env.isIOS &&
    !env.inAppWalletUA;

  const savedHistoryCount = historyCount > 0 ? historyCount : historyItems.length;

  //console.log('render', { connected, primaryIsBrowse });

  return (
    <div className="assistant-wrap reward-claim-root" style={{ padding: 'clamp(16px, 2.2vw, 24px)', display: 'grid', gap: 12 }}>
      <style>{`
        .fo-toast-stack {
          position: fixed;
          top: 18px;
          right: 18px;
          display: grid;
          gap: 10px;
          width: min(420px, calc(100% - 32px));
          z-index: 9999;
          pointer-events: none;
        }
        .fo-toast {
          display: grid;
          grid-template-columns: auto 1fr auto;
          gap: 10px;
          align-items: start;
          background: #0f151c;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-left: 4px solid #1ec2ff;
          border-radius: 10px;
          padding: 12px 14px;
          color: #eaf7ff;
          box-shadow: none;
          pointer-events: auto;
        }
        .fo-toast.success { border-left-color: #35d07f; }
        .fo-toast.warning { border-left-color: #ffb300; border-color: rgba(255, 203, 112, 0.35); }
        .fo-toast.error { border-left-color: #ff6f7d; border-color: rgba(255, 111, 125, 0.35); }
        .fo-toast__icon {
          width: 24px;
          height: 24px;
          border-radius: 8px;
          background: rgba(255, 255, 255, 0.08);
          display: grid;
          place-items: center;
          font-size: 14px;
        }
        .fo-toast__body { display: grid; gap: 4px; }
        .fo-toast__title { font-weight: 700; letter-spacing: -0.01em; }
        .fo-toast__msg { font-size: 0.95rem; color: #dfefff; }
        .fo-toast__close {
          border: none;
          background: transparent;
          color: #9ad7ff;
          cursor: pointer;
          font-size: 16px;
          padding: 2px 4px;
          opacity: 0.8;
        }
        .fo-toast__close:hover { opacity: 1; }
        .assistant-wrap {
          width: 100%;
          max-width: 1180px;
          margin: 0 auto;
          padding: 0 1rem;
          overflow-wrap: anywhere;
        }
        .assistant-wrap,
        .assistant-wrap * {
          box-sizing: border-box;
        }
        .reward-claim-root {
          background: #0b1117;
          border-radius: 16px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          box-shadow: none;
        }
        #assistant-status {
          width: 100%;
        }
        .value-loop {
          background: #0f1720;
          border-radius: 14px;
          padding: 14px 16px 16px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          box-shadow: none;
          color: #eaf7ff;
          display: grid;
          gap: 10px;
        }
        .value-loop__header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
          min-width: 0;
        }
        .value-loop__header > * {
          min-width: 0;
        }
        .value-loop__title {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          min-width: 0;
        }
        .value-loop__eyebrow {
          background: rgba(76, 199, 255, 0.18);
          color: #aee7ff;
          padding: 4px 10px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }
        .value-loop__path {
          font-weight: 800;
          font-size: 15px;
          color: #e5f6ff;
          letter-spacing: 0.02em;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
          min-width: 0;
        }
        .value-loop__wallet {
          display: inline-flex;
          align-items: baseline;
          gap: 8px;
          padding: 8px 12px;
          background: rgba(255, 255, 255, 0.04);
          border-radius: 10px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          box-shadow: none;
          max-width: 100%;
          flex-wrap: wrap;
          row-gap: 4px;
          min-width: 0;
        }
        .value-loop__wallet-label {
          font-size: 13px;
          color: #a5c6d6;
          letter-spacing: 0.01em;
        }
        .value-loop__wallet-value {
          font-size: clamp(20px, 2.4vw, 24px);
          font-weight: 700;
          color: #fff;
          letter-spacing: -0.01em;
          max-width: 100%;
          overflow-wrap: anywhere;
        }
        .value-loop__grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto minmax(0, 1fr);
          gap: 10px;
          align-items: stretch;
        }
        .value-node {
          background: rgba(12, 18, 24, 0.8);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 12px;
          padding: 12px;
          display: grid;
          gap: 6px;
          position: relative;
          min-width: 0;
        }
        .value-node__label {
          font-size: 13px;
          color: #9ac6d6;
          letter-spacing: 0.02em;
          font-weight: 700;
          overflow-wrap: anywhere;
        }
        .value-node__value {
          font-size: clamp(20px, 3vw, 28px);
          font-weight: 700;
          color: #fff;
          display: inline-flex;
          align-items: baseline;
          gap: 6px;
          flex-wrap: wrap;
          row-gap: 4px;
          letter-spacing: -0.01em;
          min-width: 0;
          max-width: 100%;
          overflow-wrap: anywhere;
        }
        .value-node__unit {
          font-size: 13px;
          color: #8ac8ff;
          font-weight: 700;
          letter-spacing: 0.03em;
        }
        .value-node__hint {
          font-size: 12px;
          color: #a8d9ff;
          overflow-wrap: anywhere;
        }
        .value-node--rp {
          border-color: rgba(111, 220, 189, 0.32);
        }
        .value-node--forca {
          border-color: rgba(126, 216, 255, 0.42);
          background: rgba(12, 24, 32, 0.9);
        }
        .value-node--pp {
          border-color: rgba(255, 183, 92, 0.35);
        }
        .value-loop__arrow {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          color: #9ad7ff;
        }
        .value-loop__arrow-line {
          display: block;
          width: 36px;
          height: 1px;
          background: rgba(154, 215, 255, 0.4);
          border-radius: 999px;
        }
        .value-loop__arrow-icon {
          font-size: 18px;
          font-weight: 800;
        }
        @media (max-width: 720px) {
          .value-loop {
            padding: 12px 12px 14px;
          }
          .value-loop__grid {
            grid-template-columns: 1fr;
          }
          .value-loop__arrow {
            transform: rotate(90deg);
          }
          .value-loop__arrow-line {
            width: 28px;
          }
        }
        .assistant-card {
          background: #0f151c;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 10px;
          padding: 12px;
          color: #dff3ff;
          box-shadow: none;
          position: relative;
          min-width: 0;
          overflow-wrap: anywhere;
        }
        .assistant-card.quest-highlight {
          border-color: rgba(76, 199, 255, 0.6);
          box-shadow: none;
          background: #0f1a22;
        }
        .quest-highlight-badge {
          position: absolute;
          top: 10px;
          right: 12px;
          background: linear-gradient(90deg, #4cc7ff, #7af3c6);
          color: #081119;
          padding: 4px 10px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.01em;
          text-transform: uppercase;
          box-shadow: 0 6px 18px rgba(76, 199, 255, 0.25);
        }
        .assistant-card h4 {
          margin: 0 0 6px;
          font-size: 1.05rem;
          color: #fff;
        }
        .assistant-card .actions {
          margin-top: 10px;
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .assistant-meta {
          font-size: 0.85rem;
          color: #b8d3e1;
          overflow-wrap: anywhere;
        }
        .assistant-subtle {
          font-size: 0.8rem;
          color: #9ac6d6;
          overflow-wrap: anywhere;
        }
        .assistant-msgs {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .assistant-msg {
          display: flex;
          gap: 10px;
        }
        .assistant-msg .bubble {
          max-width: 100%;
          padding: 12px 14px;
          border-radius: 12px;
          line-height: 1.45;
          overflow-wrap: anywhere;
        }
        .assistant-msg.typing .bubble {
          display: flex;
          align-items: center;
          gap: 10px;
          background: #0f151c;
          border: 1px solid rgba(255, 255, 255, 0.12);
          box-shadow: none;
        }
        .typing-dots {
          display: inline-flex;
          gap: 6px;
          padding: 8px 10px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .typing-dots span {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: linear-gradient(135deg, #4cc7ff, #7af3c6);
          box-shadow: 0 0 0 1px rgba(122, 215, 255, 0.25);
          animation: typingDot 1.2s ease-in-out infinite;
        }
        .typing-dots span:nth-child(2) { animation-delay: 0.12s; }
        .typing-dots span:nth-child(3) { animation-delay: 0.24s; }
        .typing-text {
          display: grid;
          gap: 2px;
        }
        .typing-title {
          font-weight: 700;
          color: #eaf7ff;
          letter-spacing: -0.01em;
        }
        .typing-hint {
          color: #9ac6d6;
          font-size: 12px;
        }
        @keyframes typingDot {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.35; }
          40% { transform: translateY(-3px); opacity: 1; }
        }
        .assistant-richtext {
          display: grid;
          gap: 8px;
          font-size: 0.95rem;
          overflow-wrap: anywhere;
        }
        .assistant-richtext p {
          margin: 0;
        }
        .assistant-richtext p + p {
          margin-top: 4px;
        }
        .assistant-richtext ul,
        .assistant-richtext ol {
          margin: 6px 0 0;
          padding-left: 0;
          display: grid;
          gap: 8px;
        }
        .assistant-richtext li {
          line-height: 1.5;
          list-style: none;
        }
        .assistant-richtext ol {
          counter-reset: ai-ol;
        }
        .assistant-richtext ol li {
          counter-increment: ai-ol;
          position: relative;
          padding-left: 28px;
        }
        .assistant-richtext ol li::before {
          content: counter(ai-ol) ".";
          position: absolute;
          left: 0;
          top: 0;
          font-weight: 700;
          color: #7ad7ff;
          width: 22px;
          text-align: left;
        }
        .assistant-richtext ul li {
          position: relative;
          padding-left: 20px;
        }
        .assistant-richtext ul li::before {
          content: "";
          position: absolute;
          left: 2px;
          top: 8px;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: linear-gradient(135deg, #4cc7ff, #7af3c6);
          box-shadow: 0 0 0 1px rgba(122, 215, 255, 0.25);
        }
        .assistant-richtext h3,
        .assistant-richtext h4,
        .assistant-richtext h5 {
          margin: 0;
          font-size: 1rem;
          line-height: 1.35;
          color: #fff;
        }
        .assistant-richtext h4,
        .assistant-richtext h5 {
          color: #dff3ff;
        }
        .assistant-richtext blockquote {
          margin: 0;
          padding: 8px 10px;
          border-left: 3px solid rgba(154, 215, 255, 0.6);
          background: rgba(255, 255, 255, 0.03);
          border-radius: 8px;
          color: #cfe9ff;
        }
        .assistant-richtext code {
          background: rgba(255, 255, 255, 0.06);
          padding: 2px 5px;
          border-radius: 6px;
          font-size: 0.9em;
          border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .assistant-richtext pre {
          margin: 0;
          padding: 10px;
          border-radius: 10px;
          background: rgba(4, 12, 18, 0.7);
          border: 1px solid rgba(255, 255, 255, 0.08);
          overflow-x: auto;
          font-size: 0.9rem;
          line-height: 1.5;
        }
        .assistant-richtext hr {
          border: none;
          border-top: 1px dashed rgba(255, 255, 255, 0.2);
          margin: 4px 0;
        }
        .assistant-richtext a {
          color: #7ad7ff;
        }
        .assistant-msg.bot .bubble {
          background: #0b1a21;
          color: #eaf7ff;
          border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .assistant-msg.user .bubble {
          background: #0b2c3a;
          color: #cfe9ff;
          border: 1px solid rgba(255, 255, 255, 0.08);
          margin-left: auto;
        }
        .assistant-btn {
          display: inline-block;
          background: #1ec2ff;
          color: #012;
          border: none;
          border-radius: 10px;
          padding: 8px 12px;
          font-weight: 600;
          cursor: pointer;
          text-decoration: none;
          max-width: 100%;
          white-space: normal;
          text-align: center;
        }
        .assistant-btn.secondary {
          background: transparent;
          color: #9ad7ff;
          border: 1px solid rgba(154, 215, 255, 0.4);
        }
        .assistant-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        .assistant-wait-banner {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-top: 8px;
          padding: 10px 12px;
          border-radius: 12px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: #0f151c;
          box-shadow: none;
        }
        .assistant-wait-banner .wait-spinner {
          width: 28px;
          height: 28px;
          border-radius: 50%;
          border: 2px solid rgba(122, 215, 255, 0.35);
          border-top-color: #7af3c6;
          animation: spin 1s linear infinite;
        }
        .assistant-wait-banner .wait-copy {
          display: grid;
          gap: 2px;
        }
        .assistant-wait-banner .wait-title {
          color: #eaf7ff;
          font-weight: 700;
          letter-spacing: -0.01em;
        }
        .assistant-wait-banner .wait-hint {
          color: #9ac6d6;
          font-size: 12px;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        .forca-wallet-anchor .wallet-adapter-dropdown {
          display: inline-block;
          width: auto !important;
        }
        .forca-wallet-anchor .wallet-adapter-button {
          width: auto !important;
        }
        .reward-dropdown-anchored .wallet-adapter-dropdown-list {
          position: fixed !important;
          top: var(--reward-dropdown-top, 0px) !important;
          left: var(--reward-dropdown-left, 0px) !important;
          transform: translate(-50%, 0) !important;
          right: auto !important;
          z-index: 9999 !important;
        }
        .reward-dropdown-anchored .wallet-adapter-dropdown-list-active {
          opacity: 1 !important;
          visibility: visible !important;
          transform: translate(-50%, 10px) !important;
        }
        .reward-dropdown-anchored .wallet-adapter-dropdown {
          margin: 0;
        }
        .tab-bar {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
          gap: 10px;
          border-bottom: 1px solid rgba(255,255,255,0.15);
          padding-bottom: 6px;
        }
        .tab-btn {
          border: 1px solid rgba(255,255,255,0.2);
          background: rgba(255,255,255,0.06);
          color: #e5e7eb;
          padding: 10px 6px;
          border-radius: 12px;
          cursor: pointer;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          font-weight: 600;
          letter-spacing: -0.01em;
          transition: background 0.15s ease, border-color 0.15s ease;
          min-width: 0;
          max-width: 100%;
        }
        .tab-btn .tab-icon {
          font-size: 20px;
          line-height: 1;
        }
        .tab-btn .tab-label {
          font-size: 13px;
          white-space: normal;
          text-align: center;
          line-height: 1.2;
          overflow-wrap: anywhere;
        }
        .tab-btn:hover {
          border-color: rgba(255,255,255,0.35);
        }
        .tab-btn.active {
          background: #1b2430;
          border-color: rgba(255,255,255,0.35);
        }
        @media (max-width: 480px) {
          .tab-bar {
            gap: 8px;
            grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
          }
          .tab-btn {
            padding: 9px 4px;
          }
          .tab-btn .tab-icon {
            font-size: 22px;
          }
          .tab-btn .tab-label {
            font-size: 12px;
          }
        }
        .snapshot-section {
          width: 100%;
          min-width: 0;
          overflow-wrap: anywhere;
        }
        .snapshot-section code {
          word-break: break-all;
        }
        .snapshot-ally-header {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          align-items: baseline;
          min-width: 0;
        }
        .snapshot-ally-header > * {
          min-width: 0;
        }
        .snapshot-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          align-items: center;
          width: 100%;
          min-width: 0;
        }
        .snapshot-actions > * {
          min-width: 0;
        }
        .snapshot-action-card {
          background: rgba(8, 14, 22, 0.45);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 12px;
          padding: 10px;
          display: grid;
          gap: 8px;
          position: relative;
          transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease, transform 0.2s ease;
        }
        .snapshot-action-card.is-highlighted {
          border-color: rgba(126, 216, 255, 0.9);
          box-shadow: 0 10px 30px rgba(70, 185, 255, 0.35), 0 0 0 1px rgba(126, 216, 255, 0.35) inset;
          background: linear-gradient(135deg, rgba(16, 54, 73, 0.55), rgba(12, 36, 52, 0.5));
          transform: translateZ(0);
        }
        .snapshot-action-card.is-highlighted::after {
          content: '';
          position: absolute;
          inset: 6px;
          border-radius: 10px;
          pointer-events: none;
          background: radial-gradient(circle, rgba(124, 216, 255, 0.18), transparent 60%);
          animation: snapshotPulse 1.6s ease-in-out 2;
        }
        .snapshot-focus-badge {
          position: absolute;
          top: -10px;
          right: 10px;
          background: linear-gradient(90deg, #4cc7ff, #9ff4c6);
          color: #031019;
          padding: 4px 10px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.01em;
          box-shadow: 0 8px 30px rgba(76, 199, 255, 0.25);
        }
        @keyframes snapshotPulse {
          0% { opacity: 0.65; }
          50% { opacity: 1; }
          100% { opacity: 0.65; }
        }
        .history-panel {
          display: grid;
          gap: 12px;
        }
        .history-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 12px;
          flex-wrap: wrap;
        }
        .history-summary {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .history-chip {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 10px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.08);
          background: rgba(255,255,255,0.04);
          color: #dfefff;
          font-size: 12px;
          letter-spacing: 0.01em;
        }
        .history-chip .chip-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          display: inline-block;
          background: #7ed8ff;
          box-shadow: 0 0 0 4px rgba(126,216,255,0.12);
        }
        .history-chip.source-pumpswap .chip-dot { background: #7ed8ff; box-shadow: 0 0 0 4px rgba(126,216,255,0.12); }
        .history-chip.source-reward_vault .chip-dot { background: #8ef5b5; box-shadow: 0 0 0 4px rgba(142,245,181,0.15); }
        .history-chip.source-shop .chip-dot { background: #ffcf7f; box-shadow: 0 0 0 4px rgba(255,207,127,0.14); }
        .history-chip.source-quest .chip-dot { background: #cba1ff; box-shadow: 0 0 0 4px rgba(203,161,255,0.16); }
        .history-list {
          display: grid;
          gap: 10px;
        }
        .history-item {
          position: relative;
          border-radius: 10px;
          padding: 12px;
          background: #0f151c;
          border: 1px solid rgba(255,255,255,0.08);
          box-shadow: none;
          display: grid;
          gap: 8px;
          overflow-wrap: anywhere;
        }
        .history-meta {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
          align-items: center;
        }
        .history-pill {
          display: inline-flex;
          align-items: center;
          padding: 4px 8px;
          border-radius: 10px;
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.08);
          font-size: 12px;
          color: #dfefff;
          letter-spacing: 0.01em;
        }
        .history-pill.source-pumpswap { border-color: rgba(126,216,255,0.3); color: #a8e4ff; }
        .history-pill.source-reward_vault { border-color: rgba(142,245,181,0.3); color: #b1f5cf; }
        .history-pill.source-shop { border-color: rgba(255,207,127,0.35); color: #ffe2ae; }
        .history-pill.source-quest { border-color: rgba(203,161,255,0.35); color: #e2c9ff; }
        .history-pill.status-ok { border-color: rgba(142,245,181,0.4); color: #b1f5cf; }
        .history-pill.status-err { border-color: rgba(255,111,125,0.5); color: #ffc3cc; }
        .history-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .history-title {
          font-weight: 700;
          color: #fff;
          letter-spacing: -0.01em;
          overflow-wrap: anywhere;
        }
        .history-amount {
          color: #8ef5b5;
          font-weight: 700;
          letter-spacing: 0.01em;
          overflow-wrap: anywhere;
        }
        .history-sub {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          color: #9ac6d6;
          font-size: 13px;
          overflow-wrap: anywhere;
        }
        .history-link {
          color: #bde3ff;
          font-size: 13px;
          overflow-wrap: anywhere;
        }
        .history-empty {
          display: grid;
          place-items: center;
          gap: 8px;
          padding: 18px;
          border: 1px dashed rgba(255,255,255,0.16);
          border-radius: 12px;
          color: #b8d3e1;
          background: rgba(255,255,255,0.02);
        }
        .history-item.skeleton {
          position: relative;
          overflow: hidden;
        }
        .history-item.skeleton::after {
          content: '';
          position: absolute;
          inset: 0;
          background: linear-gradient(90deg, transparent, rgba(255,255,255,0.04), transparent);
          animation: shimmer 1.2s linear infinite;
        }
        .history-skeleton-bar {
          height: 12px;
          border-radius: 8px;
          background: rgba(255,255,255,0.06);
        }
        .history-skeleton-meta {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        @media (max-width: 640px) {
          .snapshot-actions {
            flex-direction: column;
            align-items: stretch;
          }
          .snapshot-actions button,
          .snapshot-actions input {
            width: 100%;
          }
        }
      `}</style>
      <div className="fo-toast-stack" aria-live="polite" aria-atomic="true">
        {toasts.map((t) => (
          <div key={t.id} className={`fo-toast ${t.type}`}>
            <div className="fo-toast__icon" aria-hidden="true">{toastIcons[t.type]}</div>
            <div className="fo-toast__body">
              {t.title && <div className="fo-toast__title">{t.title}</div>}
              <div className="fo-toast__msg">{t.message}</div>
            </div>
            <button
              type="button"
              className="fo-toast__close"
              aria-label="Close notification"
              onClick={() => dismissToast(t.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {showTopUI && (
        <h2>{rewardVaultOnly ? 'Ally Devnet Reward Vault' : '$FORCA Reward Claim'}</h2>
      )}
      
      
      {connected ? (
        <div
          className="forca-wallet-anchor"
          style={{
            position: 'relative',
            display: 'inline-block',
            ...(showTopUI
              ? {}
              : {
                  visibility: 'hidden',

                  height: 0,
                  overflow: 'hidden',
                  margin: 0,
                  padding: 0,
                }),
          }}
          ref={walletAnchorRef}
        >
          <WalletMultiButton
            style={{ width: 'auto', display: 'inline-flex' }}
            onClick={handleWalletButtonClick}
          />
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'center',
            ...(showTopUI
              ? {}
              : {
                  visibility: 'hidden',

                  height: 0,
                  overflow: 'hidden',
                  margin: 0,
                  padding: 0,
                }),
          }}
        >
          <div
            className="forca-wallet-anchor"
            style={{
              position: 'relative',
              display: 'inline-block',
              ...(showTopUI
                ? {}
                : {
                    visibility: 'hidden',

                    height: 0,
                    overflow: 'hidden',
                    margin: 0,
                    padding: 0,
                  }),
            }}
            ref={walletAnchorRef}
          >
            <WalletMultiButton
              style={{ width: 'auto', display: 'inline-flex' }}
              onClick={handleWalletButtonClick}
            >
              Connect Wallet
            </WalletMultiButton>
          </div>
          <small style={{ alignSelf: 'center', opacity: .7 }}>
            or&nbsp;<a href="#" onClick={(e) => { e.preventDefault(); showOpenInWalletOverlay(); }}>Open in Wallet</a>
          </small>
        </div>
      )}

      {showSIWS && connected && (
        <>
          <div>Public Key: {publicKey?.toBase58()}</div>
          <button onClick={handleSIWS}>Sign-In with Solana (SIWS)</button>
          <button onClick={handleLegacySignIn}>Legacy Sign-In (nonce + signMessage)</button>
          <button onClick={handleTx}>Send 1 lamport (self)</button>
          <button onClick={() => disconnect()}>Disconnect</button>
        </>
      )}
      {/* Auth status & Tabs */}
      {showTopUI && !rewardVaultOnly && (
        <div style={{ fontSize: 12, opacity: .8 }}>
          Auth: {jwtToken ? 'Signed' : 'Not signed'}
        </div>
      )}
      <section
        id="assistant-status"
        className="value-loop"
        aria-label="Value loop balances"
      >
        <div className="value-loop__header">
          <div className="value-loop__title">
            <span className="value-loop__eyebrow">Value Loop</span>
            <span className="value-loop__path">RP → FORCA → PP</span>
          </div>
          <div className="value-loop__wallet" role="status" aria-live="polite">
            <span className="value-loop__wallet-label">Wallet $FORCA</span>
            <span className="value-loop__wallet-value">
              {forcaTokenBalance?.uiAmountString ?? '0'}
            </span>
          </div>
        </div>
        <div className="value-loop__grid">
          <div className="value-node value-node--rp">
            <span className="value-node__label">Claimable RP</span>
            <span className="value-node__value">
              {formatAmount(totalRpClaimable, FORCA_DECIMALS)}
              <span className="value-node__unit">RP</span>
            </span>
            <span className="value-node__hint">1 RP = 1 FORCA</span>
          </div>
          <div className="value-loop__arrow" aria-hidden="true">
            <span className="value-loop__arrow-line" />
            <span className="value-loop__arrow-icon">→</span>
          </div>
          <div className="value-node value-node--forca">
            <span className="value-node__label">$FORCA Balance</span>
            <span className="value-node__value">
              {forcaTokenBalance?.uiAmountString ?? '0'}
              <span className="value-node__unit">$FORCA</span>
            </span>
            <span className="value-node__hint">Directly converted from RP</span>
          </div>
          <div className="value-loop__arrow" aria-hidden="true">
            <span className="value-loop__arrow-line" />
            <span className="value-loop__arrow-icon">→</span>
          </div>
          <div className="value-node value-node--pp">
            <span className="value-node__label">PP Balance</span>
            <span className="value-node__value">
              {formatAmount(totalPpBalance, FORCA_DECIMALS)}
              <span className="value-node__unit">PP</span>
            </span>
            <span className="value-node__hint">1 PP = 1 USD$</span>
          </div>
        </div>
      </section>
      {!rewardVaultOnly && (
        <div className="tab-bar">
          {([
            { key: 'assistant', icon: '⭐', label: 'AI Assistant' },
            { key: 'quests', icon: '🧭', label: 'Quests' },
            { key: 'shop', icon: '🛍️', label: 'Shop' },
            { key: 'snapshot', icon: '🧾', label: 'Snapshot' },
            { key: 'history', icon: '📜', label: 'History' },
          ] as const).map(({ key, icon, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setCurrentTab(key)}
              className={`tab-btn ${currentTab === key ? 'active' : ''}`}
              aria-pressed={currentTab === key}
            >
              <span className="tab-icon" aria-hidden="true">{icon}</span>
              <span className="tab-label">{label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Assistant Tab */}
      {connected && currentTab === 'assistant' && (
        <div style={{ display: 'grid', gap: 16 }}>
          <div className="assistant-actions" style={{ gap: 12 }}>
            {assistantCards}
          </div>
          <div className="assistant-chat">
            {turnstileEnabled && (
              <div
                ref={turnstileElRef}
                aria-hidden="true"
                style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0, pointerEvents: 'none' }}
              />
            )}
            <div style={{ marginBottom: 12 }}>
              {(historyAvailable || historyItems.length > 0) && (
                <div className="assistant-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div>
                    <h4 style={{ margin: 0 }}>Chat History</h4>
                    <div className="assistant-meta" style={{ marginTop: 4 }}>
                      {`${savedHistoryCount} saved message${savedHistoryCount === 1 ? '' : 's'}`}
                    </div>
                  </div>
                  <div className="assistant-subtle" style={{ marginTop: 4 }}>
                    Actions appear as cards below. Tap “View history” to expand recent messages, or clear them when you need a fresh start.
                  </div>
                  {historyError && (
                    <div className="assistant-subtle" style={{ color: '#ff9fb8', fontSize: 12 }}>
                      <span><strong>Error:</strong> {historyError}. </span>
                      <button
                        type="button"
                        className="assistant-btn secondary"
                        style={{ padding: '4px 8px', fontSize: 12 }}
                        onClick={loadChatHistory}
                      >
                        Retry
                      </button>
                    </div>
                  )}
                  <div className="actions" style={{ gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                    <button
                      className="assistant-btn"
                      type="button"
                      onClick={loadChatHistory}
                      disabled={historyLoading}
                    >
                      {historyLoading ? 'Loading history…' : 'View history'}
                    </button>
                    <button
                      className="assistant-btn secondary"
                      type="button"
                      onClick={clearChatHistory}
                      disabled={historyLoading}
                    >
                      Clear history
                    </button>
                  </div>
                  <div className="assistant-subtle" style={{ marginTop: 2, fontSize: 12 }}>
                    Source: flashorca.chats · Auth: JWT
                  </div>
                </div>
              )}
              {historyPanelOpen && historyItems.length > 0 && (
                <div
                  className="assistant-card"
                  style={{
                    marginTop: 8,
                    maxHeight: 240,
                    overflowY: 'auto',
                    padding: '10px 14px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <strong style={{ fontSize: 14 }}>Recent entries</strong>
                  {historyItems.length === 0 ? (
                    <div className="assistant-subtle">No history stored yet.</div>
                  ) : (
                    historyItems.map((entry, idx) => (
                      // 최근 메시지에서도 Markdown을 기존 챗 버블과 동일한 방식으로 표현
                      <div
                        key={`${entry.ts}-${idx}`}
                        style={{
                          paddingBottom: 6,
                          borderBottom: idx === historyItems.length - 1 ? 'none' : '1px dashed rgba(255,255,255,0.2)',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, opacity: 0.7 }}>
                          <span>{entry.role === 'user' ? 'You' : 'Assistant'}</span>
                          <span>{new Date(entry.ts).toLocaleString(undefined, { hour12: false })}</span>
                        </div>
                        <div style={{ fontSize: 14, marginTop: 4 }}>
                          {entry.text ? (
                            <div
                              className="assistant-richtext"
                              dangerouslySetInnerHTML={{ __html: renderAssistantMarkdown(entry.text) }}
                            />
                          ) : (
                            ''
                          )}
                        </div>
                      </div>
                    ))
                  )}
                  <div className="actions" style={{ marginTop: 6, justifyContent: 'flex-end', gap: 8 }}>
                    <button
                      className="assistant-btn secondary"
                      type="button"
                      onClick={() => setHistoryPanelOpen(false)}
                    >
                      Hide
                    </button>
                    <button
                      className="assistant-btn"
                      type="button"
                      onClick={clearChatHistory}
                      disabled={historyLoading}
                    >
                      Clear history
                    </button>
                  </div>
                </div>
              )}
              {showContextHelper && (
                <div
                  className="assistant-card"
                  style={{
                    display: 'grid',
                    gap: 8,
                    marginTop: historyAvailable || historyItems.length > 0 || historyPanelOpen ? 12 : 0,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <div>
                      <h4 style={{ margin: 0 }}>Context helper</h4>
                      <div className="assistant-meta" style={{ marginTop: 4 }}>
                        Peek at the context bundled with /chat requests whenever you need it.
                      </div>
                    </div>
                    <label className="assistant-subtle" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={contextPeekEnabled}
                        onChange={(e) => {
                          setContextPeekEnabled(e.target.checked);
                          if (!e.target.checked) {
                            setContextPreview(null);
                            setContextPeekOpen(false);
                          }
                        }}
                      />
                      Request context details
                    </label>
                  </div>
                  <div className="assistant-subtle" style={{ marginTop: 2 }}>
                    {contextPeekEnabled
                      ? 'Context will be returned with the next messages (not stored on the server).'
                      : 'Keep this off by default; responses stay lightweight until you turn it on.'}
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <button
                      type="button"
                      className="assistant-btn secondary"
                      onClick={() => setContextPeekOpen((v) => !v)}
                      disabled={!contextPreview || contextPreview.pending}
                      style={{ padding: '6px 10px' }}
                    >
                      {contextPeekOpen ? 'Hide details' : 'View latest context'}
                    </button>
                    {contextPreview?.pending && (
                      <span className="assistant-subtle" style={{ fontSize: 12 }}>Fetching context from the last message…</span>
                    )}
                    {!contextPreview && contextPeekEnabled && (
                      <span className="assistant-subtle" style={{ fontSize: 12 }}>Send a message to see its context here.</span>
                    )}
                  </div>
                  {contextPreview && contextPeekOpen && (
                    <div style={{ border: '1px dashed rgba(255,255,255,0.25)', borderRadius: 10, padding: 10, display: 'grid', gap: 10, background: 'rgba(12,15,22,0.55)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <div className="assistant-meta" style={{ fontWeight: 600 }}>
                          {contextPreview.userQuestion ? `Question: ${contextPreview.userQuestion}` : 'Based on the latest message'}
                        </div>
                        <div className="assistant-subtle" style={{ fontSize: 12 }}>
                          {contextPreview.ts ? new Date(contextPreview.ts).toLocaleString(undefined, { hour12: false }) : ''}
                        </div>
                      </div>
                      {contextPreview.clientContext && (
                        <div style={{ display: 'grid', gap: 6 }}>
                          <div className="assistant-subtle" style={{ color: '#9ad7ff' }}>Client context</div>
                          {Object.entries(contextPreview.clientContext).map(([k, v]) => (
                            <div key={k} style={{ fontSize: 12, borderRadius: 6, padding: '6px 8px', background: 'rgba(255,255,255,0.04)' }}>
                              <strong style={{ fontWeight: 600 }}>{k}</strong>
                              <div style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}>{v}</div>
                            </div>
                          ))}
                        </div>
                      )}
                      <div style={{ display: 'grid', gap: 8 }}>
                        {(contextPreview.sections && contextPreview.sections.length > 0 ? contextPreview.sections : [{ title: 'Context', text: '(no context captured)' }]).map((s, idx) => (
                          <div key={`${s.title || 'section'}-${idx}`} style={{ borderRadius: 8, padding: '8px 10px', background: 'rgba(255,255,255,0.03)' }}>
                            <div className="assistant-subtle" style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                              <span>{s.title || `Context ${idx + 1}`}</span>
                              {typeof s.length === 'number' && s.length > 0 && <span style={{ fontSize: 11, opacity: 0.75 }}>{s.length} chars</span>}
                            </div>
                            <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.5 }}>{s.text || '(empty)'}</pre>
                          </div>
                        ))}
                      </div>
                      {contextPreview.augmented && (
                        <details>
                          <summary className="assistant-subtle" style={{ cursor: 'pointer' }}>View composed prompt</summary>
                          <pre style={{ marginTop: 6, whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.5 }}>{contextPreview.augmented}</pre>
                        </details>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="assistant-msgs">
              {assistantMessages.map((m, i) => {
                const botHtml = m.role === 'bot' ? (m.html ?? renderAssistantMarkdown(m.text)) : null;
                return (
                  <div key={i} className={`assistant-msg ${m.role}`}>
                    <div className="bubble">
                      {botHtml ? (
                        <div className="assistant-richtext" dangerouslySetInnerHTML={{ __html: botHtml }} />
                      ) : (
                        m.text
                      )}
                    </div>
                  </div>
                );
              })}
              {chatSending && (
                <div className="assistant-msg bot typing" role="status" aria-live="polite">
                  <div className="bubble typing-bubble">
                    <div className="typing-dots" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </div>
                    <div className="typing-text">
                      <div className="typing-title">Flashorca is drafting your reply</div>
                      <div className="typing-hint">{chatWaitHint}</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
              <div style={{ fontSize: 12, opacity: .85 }}>
                {chatQuota
                  ? `AI quota remains: ${chatQuota.remaining}`
                  : 'AI quota not loaded'}
              </div>
              {chatQuota && chatQuota.remaining <= 0 && (
                <button
                  type="button"
                  className="assistant-btn secondary"
                  onClick={openBuyQuota}
                  style={{ padding: '4px 8px', fontSize: 12 }}
                >
                  Get more
                </button>
              )}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const input = e.currentTarget.elements.namedItem('q') as HTMLInputElement;
                const t = input?.value.trim();
                if (chatSending) return;
                if (t && (!chatQuota || chatQuota.remaining > 0)) {
                  sendAssistantMessage(t);
                  input.value = '';
                }
              }}
              style={{ marginTop: 12 }}
            >
              <input
                name="q"
                placeholder="Ask me anything…"
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid rgba(255,255,255,0.2)',
                  background: 'transparent',
                  color: '#fff',
                }}
                disabled={chatSending || (!!chatQuota && chatQuota.remaining <= 0)}
              />
              {chatSending && (
                <div className="assistant-wait-banner" role="status" aria-live="polite">
                  <div className="wait-spinner" aria-hidden="true" />
                  <div className="wait-copy">
                    <div className="wait-title">Hold tight — your reply is on the way</div>
                    <div className="wait-hint">{chatWaitHint}</div>
                  </div>
                </div>
              )}
            </form>
          </div>
        </div>
      )}

      {/* Shop Tab */}
      {connected && currentTab === 'shop' && (
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="assistant-card" style={{ display: 'grid', gap: 8 }}>
            <h4>Donate PP to Community</h4>
            <div className="assistant-meta">Request to allocate PP for community marketing. Price: user-defined (PP)</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <input
                value={donateAmount}
                onChange={(e) => { setDonateAmount(e.target.value); setDonateMsg(null); }}
                placeholder="Amount (PP)"
                inputMode="decimal"
                style={{
                  flex: '1 1 160px',
                  minWidth: 140,
                  padding: '6px 10px',
                  borderRadius: 6,
                  border: '1px solid rgba(255,255,255,0.25)',
                  background: 'rgba(12,15,22,0.65)',
                  color: '#fff',
                }}
              />
              <input
                value={donateNote}
                onChange={(e) => setDonateNote(e.target.value)}
                placeholder="Note (optional)"
                style={{
                  flex: '2 1 220px',
                  minWidth: 180,
                  padding: '6px 10px',
                  borderRadius: 6,
                  border: '1px solid rgba(255,255,255,0.25)',
                  background: 'rgba(12,15,22,0.65)',
                  color: '#fff',
                }}
              />
              <button
                className="assistant-btn"
                disabled={donateBusy || !jwtToken}
                onClick={async () => {
                  setDonateBusy(true); setDonateMsg(null);
                  const tok = await ensureJwt();
                  if (!tok) { setDonateBusy(false); return; }
                  if (!rewardSnapshot) {
                    setDonateMsg({ text: 'Loading PP balance. Please try again in a moment.' });
                    triggerSnapshotReload([0, 1200, 3000]);
                    setDonateBusy(false);
                    pushToast('Syncing PP balance. Please try again shortly.', { type: 'info', title: 'Balance syncing', source: 'shop' });
                    return;
                  }
                  const amountPpE6 = parseDecimalAmount(donateAmount, FORCA_DECIMALS);
                  if (amountPpE6 === null || amountPpE6 <= 0n) {
                    setDonateMsg({ text: 'Please enter a valid number (up to 6 decimals).' });
                    pushToast('Enter a numeric donation amount (up to 6 decimals).', { type: 'warning', title: 'Invalid amount', source: 'shop' });
                    setDonateBusy(false);
                    return;
                  }
                  if (totalPpBalance < amountPpE6) {
                    setDonateMsg({ text: `Insufficient PP balance (current ${formatAmount(totalPpBalance, FORCA_DECIMALS)} PP).` });
                    pushToast('Insufficient PP balance.', { type: 'warning', title: 'Insufficient balance', source: 'shop' });
                    setDonateBusy(false);
                    return;
                  }
                  try {
                    const res = await fetch('/api/shop/donate', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
                      body: JSON.stringify({ amount_pp: Number(amountPpE6) / 1_000_000, note: donateNote }),
                    });
                    const body = await res.json().catch(() => null);
                    if (!res.ok || body?.ok === false) {
                      throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
                    }
                    const sig = body?.tx_sig || body?.onchain_receipt?.tx_sig;
                    const baseText = 'Thanks! Your request has been received.';
                    const refreshingText = sig ? `${baseText} Refreshing balance…` : baseText;
                    setDonateMsg({
                      text: refreshingText,
                      tx: sig,
                    });
                    const humanAmt = formatAmount(amountPpE6, FORCA_DECIMALS, 'PP');
                    logUx(`Donate request submitted (${humanAmt}${donateNote ? ` | note: ${donateNote}` : ''}${sig ? ` | tx: ${truncateSig(sig)}` : ''})`, { level: 'success', source: 'shop' });
                    pushToast('Donation request submitted. Refreshing balance.', { type: 'success', title: 'Donation submitted', source: 'shop' });
                    setDonateAmount('');
                    setDonateNote('');
                    triggerSnapshotReload([0, 1500, 4000, 8000]);
                    if (sig) {
                      void finalizeTxMessageAfterRefresh(setDonateMsg, {
                        tx: sig,
                        refreshingText,
                        finalText: `${baseText} Balance refreshed.`,
                        timeoutText: `${baseText} Balance refresh may take a few more seconds.`,
                      });
                    }
                  } catch (e: any) {
                    setDonateMsg({ text: e?.message || 'Failed to process the request.' });
                    pushToast(`Donation request failed: ${e?.message || 'unknown error'}`, { type: 'error', title: 'Donation failed', source: 'shop' });
                    logUx(`Donate request failed: ${e?.message || e}`, { level: 'error', source: 'shop' });
                  } finally { setDonateBusy(false); }
                }}
              >Donate</button>
            </div>
            <div className="assistant-subtle" style={{ marginTop: 4 }}>
              Current PP balance (snapshot): {formatAmount(totalPpBalance, FORCA_DECIMALS)}
            </div>
            {donateMsg && (
              <div className="assistant-subtle" style={{ color: '#9ad7ff', display: 'grid', gap: 4 }}>
                <span>{donateMsg.text}</span>
                {donateMsg.tx && (
                  <a
                    href={explorerTxUrl(donateMsg.tx) ?? undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: '#bde3ff' }}
                  >
                    View on Solscan ({truncateSig(donateMsg.tx)})
                  </a>
                )}
              </div>
            )}
          </div>

          <div className="assistant-card" style={{ display: 'grid', gap: 8 }}>
            <h4>Chat Pack +10</h4>
            <div className="assistant-meta">Increase /chat quota by 10. Price: 1 PP</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <button
                className="assistant-btn"
                disabled={chatBuyBusy || !jwtToken}
                onClick={async () => {
                  setChatBuyBusy(true); setChatBuyMsg(null);
                  const tok = await ensureJwt();
                  if (!tok) { setChatBuyBusy(false); return; }
                  const costPpE6 = 1_000_000n;
                  if (!rewardSnapshot) {
                    setChatBuyMsg({ text: 'Loading PP balance. Please try again in a moment.' });
                    triggerSnapshotReload([0, 1200, 3000]);
                    setChatBuyBusy(false);
                    pushToast('Syncing PP balance. Please try again shortly.', { type: 'info', title: 'Balance syncing', source: 'shop' });
                    return;
                  }
                  if (totalPpBalance < costPpE6) {
                    setChatBuyMsg({ text: `Insufficient PP (need 1 PP, have ${formatAmount(totalPpBalance, FORCA_DECIMALS)} PP).` });
                    pushToast('You need at least 1 PP. Please check your balance.', { type: 'warning', title: 'Insufficient balance', source: 'shop' });
                    setChatBuyBusy(false);
                    return;
                  }
                  try {
                    const res = await fetch('/api/shop/buy_chat_pack', {
                      method: 'POST',
                      headers: { Authorization: `Bearer ${tok}` },
                    });
                    const body = await res.json().catch(() => null);
                    if (!res.ok || body?.ok === false) {
                      throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
                    }
                    const sig = body?.tx_sig || body?.onchain_receipt?.tx_sig;
                    const baseText = 'Purchase completed!';
                    const refreshingText = sig ? `${baseText} Refreshing balance…` : baseText;
                    setChatBuyMsg({
                      text: refreshingText,
                      tx: sig,
                    });
                    logUx(`Chat pack purchased (+10 quota${sig ? ` | tx: ${truncateSig(sig)}` : ''})`, { level: 'success', source: 'shop' });
                    pushToast('Chat pack purchased. Refreshing balance and quota.', { type: 'success', title: 'Chat pack purchased', source: 'shop' });
                    await refreshChatQuota();
                    triggerSnapshotReload([0, 1500, 4000, 8000]);
                    if (sig) {
                      void finalizeTxMessageAfterRefresh(setChatBuyMsg, {
                        tx: sig,
                        refreshingText,
                        finalText: `${baseText} Balance refreshed.`,
                        timeoutText: `${baseText} Balance refresh may take a few more seconds.`,
                      });
                    }
                  } catch (e: any) {
                    setChatBuyMsg({ text: e?.message || 'Failed to complete the purchase.' });
                    pushToast(`Chat pack purchase failed: ${e?.message || 'unknown error'}`, { type: 'error', title: 'Purchase failed', source: 'shop' });
                    logUx(`Chat pack purchase failed: ${e?.message || e}`, { level: 'error', source: 'shop' });
                  } finally { setChatBuyBusy(false); }
                }}
              >Buy (+10 chats)</button>
              {chatQuota && (
                <span className="assistant-subtle">Current quota: {chatQuota.remaining}</span>
              )}
            </div>
            <div className="assistant-subtle" style={{ marginTop: 4 }}>
              Current PP balance (snapshot): {formatAmount(totalPpBalance, FORCA_DECIMALS)}
            </div>
            {chatBuyMsg && (
              <div className="assistant-subtle" style={{ color: '#9ad7ff', display: 'grid', gap: 4 }}>
                <span>{chatBuyMsg.text}</span>
                {chatBuyMsg.tx && (
                  <a
                    href={explorerTxUrl(chatBuyMsg.tx) ?? undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: '#bde3ff' }}
                  >
                    View on Solscan ({truncateSig(chatBuyMsg.tx)})
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* History Tab */}
      {connected && currentTab === 'history' && (
        <div className="history-panel">
          <div className="history-header">
            <div>
              <h4 style={{ margin: 0 }}>History</h4>
              <div className="assistant-meta">Unified timeline across PumpSwap trades, Reward Vault actions, shop orders, and quest events.</div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                className="assistant-btn secondary"
                type="button"
                onClick={() => fetchHistoryTimeline({ force: true, reset: true })}
                disabled={timelineLoading}
              >
                {timelineLoading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
          </div>
          <div className="history-summary">
            {historySourceOrder.map((src) => {
              const active = timelineFilters.includes(src);
              const toggle = () => {
                setTimelineCursor(null);
                setTimelineHasMore(false);
                setTimelineEntries([]);
                setTimelineError(null);
                setTimelineFilters((prev) => {
                  if (prev.includes(src)) {
                    const next = prev.filter((s) => s !== src);
                    return next.length === 0 ? historySourceOrder : next;
                  }
                  const next = [...prev, src];
                  return next;
                });
              };
              return (
                <button
                  key={src}
                  type="button"
                  className={`history-chip source-${src}`}
                  style={{ opacity: active ? 1 : 0.5, cursor: 'pointer' }}
                  onClick={toggle}
                >
                  <span className="chip-dot" aria-hidden="true" />
                  {historySourceLabels[src]} ({timelineCounts?.[src] ?? 0})
                </button>
              );
            })}
          </div>
          {timelineError && (
            <div className="assistant-subtle" style={{ color: '#ff9fb8' }}>
              {timelineError}
            </div>
          )}
          <div className="history-list">
            {timelineLoading && timelineEntries.length === 0 && (
              <>
                <div className="history-item skeleton">
                  <div className="history-skeleton-meta">
                    <div className="history-skeleton-bar" style={{ width: '90px' }} />
                    <div className="history-skeleton-bar" style={{ width: '60px' }} />
                  </div>
                  <div className="history-skeleton-bar" style={{ width: '70%' }} />
                  <div className="history-skeleton-bar" style={{ width: '50%' }} />
                </div>
                <div className="history-item skeleton">
                  <div className="history-skeleton-meta">
                    <div className="history-skeleton-bar" style={{ width: '80px' }} />
                  </div>
                  <div className="history-skeleton-bar" style={{ width: '65%' }} />
                  <div className="history-skeleton-bar" style={{ width: '48%' }} />
                </div>
              </>
            )}
            {!timelineLoading && timelineEntries.length === 0 && (
              <div className="history-empty">
                <div className="assistant-meta">No activity recorded yet.</div>
                <button
                  className="assistant-btn secondary"
                  type="button"
                  onClick={() => fetchHistoryTimeline({ force: true })}
                >
                  Refresh
                </button>
              </div>
            )}
            {timelineEntries.map((item) => {
              const tsLabel = formatDateTime(item.ts ?? null) || item.ts || 'n/a';
              const srcClass = item.source ? `source-${item.source}` : '';
              const statusClass = item.status ? `status-${item.status}` : '';
              const statusLabel = item.status || null;
              return (
                <div key={item.id} className="history-item">
                  <div className="history-meta">
                    <span className={`history-pill ${srcClass}`}>{historySourceLabels[item.source] || item.source}</span>
                    {statusLabel && (
                      <span className={`history-pill status ${statusClass}`}>{statusLabel}</span>
                    )}
                  </div>
                  <div className="history-row">
                    <div className="history-title">{item.title || 'Event'}</div>
                    {item.amount_label && <div className="history-amount">{item.amount_label}</div>}
                  </div>
                  <div className="history-sub">
                    <span>{tsLabel}</span>
                    {item.subtitle && <span>• {item.subtitle}</span>}
                    {item.slot ? <span>• Slot {item.slot}</span> : null}
                  </div>
                  {item.txid && (
                    <a
                      className="history-link"
                      href={explorerTxUrl(item.txid) ?? undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View on Solscan ({truncateSig(item.txid)})
                    </a>
                  )}
                </div>
              );
            })}
            {timelineHasMore && (
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: 6 }}>
                <button
                  className="assistant-btn"
                  type="button"
                  onClick={() => fetchHistoryTimeline({})}
                  disabled={timelineLoading}
                >
                  {timelineLoading ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Quests Tab */}
      {connected && currentTab === 'quests' && (
        <div
          style={{
            marginTop: 8,
            padding: 14,
            borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'rgba(16,19,26,0.35)',
            display: 'grid',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong>Quests</strong>
            <button className="assistant-btn secondary" onClick={() => fetchQuests()}>Refresh</button>
          </div>

          {/* 카드: 미수락 퀘스트 */}
          {outstandingQuests.length > 0 && (
            <div className="assistant-card">
              <h4>New quests</h4>
              <div className="assistant-meta">One screen, one decision — summary + primary action</div>
              <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                {outstandingQuests.map(q => {
                  const isAccepting = questAccepting === q.quest_id;
                  return (
                    <div key={`new-${q.quest_id}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', borderBottom: '1px dashed rgba(255,255,255,0.15)', paddingBottom: 6 }}>
                      <div>
                        <div style={{ fontWeight: 600 }}>{q.title}</div>
                        <div className="assistant-subtle">Reward: {q.reward_label || (typeof q.reward_rp === 'number' && q.reward_rp > 0 ? `+${q.reward_rp} RP` : normalizePopLabel(q.reward_pop) ? `PoP Level: ${normalizePopLabel(q.reward_pop)}` : '')}</div>
                      </div>
                      <button className="assistant-btn" disabled={!!questAccepting} onClick={() => acceptQuest(q.quest_id)}>
                        {isAccepting ? 'Accepting…' : 'Accept'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 카드: 수락된 퀘스트 진행 */}
          {quests.length === 0 && (
            <div className="assistant-card">
              <h4>No accepted quests</h4>
              <div className="assistant-meta">Accept a new quest above to get started.</div>
            </div>
          )}

          {quests.map((q) => {
            const def = questDefs[q.quest_id] || {};
            const meta = q.meta || {};
            const status = q.status;
            const rewardState = questRewardStates[q.quest_id];
            const rewardTx = rewardState?.tx || meta?.reward_tx_sig || (q as any).reward_tx_sig || null;
            const normalizedStatus = status === 'completed' && rewardTx ? 'rewarded' : status;
            const rewardGranted = normalizedStatus === 'rewarded' || rewardState?.status === 'success';
            const canClaim = normalizedStatus === 'completed' && !rewardGranted;
            const disabled = rewardGranted;
            const rewardBadge = getQuestRewardBadge(q.quest_id);
            const highlight = currentTab === 'quests' && recentlyAcceptedQuestId === q.quest_id;
            const cardClassName = `assistant-card${highlight ? ' quest-highlight' : ''}`;
            const highlightBadge = highlight ? (
              <div className="quest-highlight-badge">Just accepted</div>
            ) : null;
            const highlightNote = highlight ? (
              <div className="assistant-subtle" style={{ marginTop: 6, color: '#c5f3ff', fontWeight: 600 }}>
                Refreshed with your latest acceptance — start here to finish the quest.
              </div>
            ) : null;
            const wrapQuestCard = (children: ReactNode) => (
              <div className={cardClassName} ref={(el) => { questCardRefs.current[q.quest_id] = el; }}>
                {highlightBadge}
                {children}
              </div>
            );
            const rewardCompletion = rewardGranted ? (
              <div className="assistant-subtle" style={{ color: '#8ef5b5', display: 'grid', gap: 4 }}>
                <span>{normalizedStatus === 'rewarded' ? 'Rewarded' : 'Completed'} · {rewardBadge}</span>
                {rewardTx && (
                  <a
                    href={explorerTxUrl(rewardTx) ?? undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: '#bde3ff' }}
                  >
                    View on Solscan ({truncateSig(rewardTx)})
                  </a>
                )}
              </div>
            ) : null;
            const Section = () => {
              switch (q.quest_id) {
                case 'quest1_x_link': {
                  const linkedHandle = meta.x_username || meta.x_handle;
                  const linkedId = meta.x_user_id;
                  const linkedAtRaw = meta.linked_at;
                  const linkedAt = formatDateTime(linkedAtRaw);
                  const acceptedAt = formatDateTime(q.accepted_at);
                  const lastUpdatedAt = formatDateTime(q.last_updated_at);
                  const scope = meta.scope || defaultXScope;
                  const profileError = meta.profile_error;
                  const statusColor = xOauthStatus?.startsWith('Timed') || xOauthStatus?.startsWith('Allow') ? '#ffb300' : '#9ad7ff';
                  return wrapQuestCard(
                    <>
                      <h4>Quest 1-1 · Link X account</h4>
                      <div className="assistant-meta">Sign in with X (OAuth 2.0) to prove account ownership.</div>
                      {highlightNote}
                      <div className="assistant-subtle" style={{ marginTop: 6 }}>
                        Reward: {rewardBadge}
                      </div>
                      <div className="assistant-subtle" style={{ marginTop: 6 }}>
                        Official:{' '}
                        <a href={`https://x.com/${official?.x_handle || 'FlashOrcaCoin'}`} target="_blank" rel="noopener">
                          @{official?.x_handle || 'FlashOrcaCoin'}
                        </a>{' '}
                        · scope: {scope}
                      </div>
                      {linkedHandle ? (
                        <div className="assistant-subtle" style={{ marginTop: 6 }}>
                          Linked as <strong>@{linkedHandle}</strong>
                          {linkedId ? ` · id ${linkedId}` : ''}
                          {linkedAt ? ` · linked at ${linkedAt}` : ''}
                          {lastUpdatedAt ? ` · updated ${lastUpdatedAt}` : ''}
                        </div>
                      ) : (
                        <div className="assistant-subtle" style={{ marginTop: 6 }}>Not linked yet.</div>
                      )}
                      {acceptedAt && (
                        <div className="assistant-subtle" style={{ marginTop: 2 }}>
                          Accepted at {acceptedAt}
                        </div>
                      )}
                      {profileError && (
                        <div className="assistant-subtle" style={{ marginTop: 2, color: '#ffb300' }}>
                          Profile not loaded ({profileError})
                        </div>
                      )}
                      {xOauthStatus && (
                        <div className="assistant-subtle" style={{ color: statusColor, marginTop: 4 }}>
                          {xOauthStatus}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <button className="assistant-btn" style={{ minWidth: 180 }} disabled={xOauthPending} onClick={startXOauth}>
                          {xOauthPending ? 'Waiting for X...' : 'Sign in with X'}
                        </button>
                        {renderQuestRewardAction('quest1_x_link', rewardGranted, {
                          showButton: canClaim && !rewardGranted,
                          showMessageWhenHidden: true,
                          hideMessageOnSuccess: rewardGranted,
                        })}
                        {rewardCompletion}
                      </div>
                      <div className="assistant-subtle" style={{ marginTop: 4, fontSize: 12 }}>
                        We open X’s official OAuth window. No DMs or passwords requested.
                      </div>
                    </>
                  );
                }
                case 'quest1_telegram_link': {
                  const botUsername = def.telegram_bot_username || def.telegram_bot || def.bot_username;
                  const linkedHandle = meta.telegram_username || questTelegramMeta?.telegram_username;
                  const linkedId = meta.telegram_id || meta.id || questTelegramMeta?.telegram_id;
                  const linkedAt = formatDateTime(meta.linked_at || questTelegramMeta?.linked_at);
                  const authAt = formatDateTime(meta.auth_date || questTelegramMeta?.auth_date);
                  const ready = Boolean(botUsername);
                  const statusColor = telegramStatus && telegramStatus.toLowerCase().includes('fail') ? '#ff8080' : '#9ad7ff';
                  return wrapQuestCard(
                    <>
                      <h4>Quest 1-2 · Link Telegram account</h4>
                      <div className="assistant-meta">Authenticate ownership via the Telegram Login Widget.</div>
                      {highlightNote}
                      <div className="assistant-subtle" style={{ marginTop: 6 }}>
                        Reward: {rewardBadge}
                      </div>
                      <div className="assistant-subtle" style={{ marginTop: 6 }}>
                        Bot: {botUsername ? <strong>@{botUsername}</strong> : 'Not configured'}
                      </div>
                      {linkedHandle ? (
                        <div className="assistant-subtle" style={{ marginTop: 6 }}>
                          Linked as <strong>@{linkedHandle}</strong>
                          {linkedId ? ` · id ${linkedId}` : ''}
                          {linkedAt ? ` · linked at ${linkedAt}` : ''}
                          {authAt ? ` · auth ${authAt}` : ''}
                        </div>
                      ) : (
                        <div className="assistant-subtle" style={{ marginTop: 6 }}>Not linked yet.</div>
                      )}
                      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <button className="assistant-btn" style={{ minWidth: 180 }} disabled={telegramPending || !ready} onClick={startTelegramLink}>
                          {telegramPending ? 'Waiting for Telegram…' : 'Sign in with Telegram'}
                        </button>
                        {renderQuestRewardAction('quest1_telegram_link', rewardGranted, {
                          showButton: canClaim && !rewardGranted,
                          showMessageWhenHidden: true,
                          hideMessageOnSuccess: rewardGranted,
                        })}
                        {rewardCompletion}
                      </div>
                      {telegramStatus && (
                        <div className="assistant-subtle" style={{ marginTop: 4, color: statusColor }}>
                          {telegramStatus}
                        </div>
                      )}
                      {!ready && (
                        <div className="assistant-subtle" style={{ marginTop: 4, color: '#ff8080' }}>
                          Available once the Telegram bot info is configured.
                        </div>
                      )}
                    </>
                  );
                }
                case 'quest2_x_follow': {
                  const targetHandle = (official?.x_handle || 'FlashOrcaCoin').replace(/^@/, '') || 'FlashOrcaCoin';
                  const targetUrl = `https://x.com/${targetHandle}`;
                  const linkedHandle = meta.x_username || meta.x_handle || quest1Meta?.x_username;
                  const followDetected = Boolean(meta.follow_detected);
                  const lastIndexed = formatDateTime(meta.follow_fetched_at || meta.last_indexed_at);
                  const lastChecked = formatDateTime(meta.last_checked_at);
                  const statusText = meta.follow_status_text || (followDetected ? 'Detected via followers snapshot.' : 'Waiting for the next follower sync (hourly).');
                  const missingLink = !linkedHandle;
                  const statusColor = missingLink ? '#ff8080' : (followDetected ? '#8ef5b5' : '#ffb300');
                  const syncMeta: string[] = [];
                  if (lastIndexed) syncMeta.push(`Indexer: ${lastIndexed}`);
                  if (lastChecked) syncMeta.push(`Checked: ${lastChecked}`);
                  const showPrimaryAction = isQuestActionVisible(normalizedStatus, rewardGranted);
                  const primaryDisabled = missingLink;
                  const primaryLabel = missingLink ? 'Link X first' : 'Check now';
                  return wrapQuestCard(
                    <>
                      <h4>Quest 2-1 · Follow official X</h4>
                      <div className="assistant-meta">Auto-checks with your linked Quest 1-1 account — no handle entry required.</div>
                      {highlightNote}
                      <div className="assistant-subtle" style={{ marginTop: 6 }}>Reward: {rewardBadge}</div>
                      <div className="assistant-subtle" style={{ marginTop: 6 }}>
                        Linked: {linkedHandle ? <strong>@{linkedHandle}</strong> : 'Link via Quest 1-1'} · Target:{' '}
                        {targetHandle ? (
                          <a href={targetUrl} target="_blank" rel="noopener noreferrer">
                            @{targetHandle}
                          </a>
                        ) : (
                          'Not set'
                        )}
                      </div>
                      <div className="assistant-subtle" style={{ marginTop: 4, color: statusColor }}>
                        {statusText}
                      </div>
                      {syncMeta.length > 0 && (
                        <div className="assistant-subtle" style={{ marginTop: 4 }}>
                          {syncMeta.join(' · ')}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                        <a className="assistant-btn secondary" href={targetUrl} target="_blank" rel="noopener noreferrer">
                          Open X
                        </a>
                        {showPrimaryAction && (
                          <button className="assistant-btn" disabled={primaryDisabled} onClick={() => verifyQuest('quest2_x_follow', {})}>
                            {primaryLabel}
                          </button>
                        )}
                        {renderQuestRewardAction('quest2_x_follow', disabled, { showButton: canClaim, showMessageWhenHidden: true, hideMessageOnSuccess: rewardGranted })}
                        {rewardCompletion}
                      </div>
                      {missingLink && (
                        <div className="assistant-subtle" style={{ marginTop: 4, color: '#ffb300' }}>
                          Complete Quest 1-1 to attach your X account for detection.
                        </div>
                      )}
                    </>
                  );
                }
                case 'quest2_telegram_join': {
                  const linkedHandle = meta.telegram_username || questTelegramMeta?.telegram_username;
                  const linkedId = meta.telegram_id || questTelegramMeta?.telegram_id;
                  const targetChat = meta.chat_username || def?.telegram_chat_username || 'flashorca';
                  const targetHandle = (typeof targetChat === 'string' ? targetChat : '').replace(/^@/, '') || 'flashorca';
                  const targetUrl = `https://t.me/${targetHandle}`;
                  const joinDetected = Boolean(meta.join_detected);
                  const lastIndexed = formatDateTime(meta.last_indexed_at);
                  const lastChecked = formatDateTime(meta.last_checked_at);
                  const joinFetched = formatDateTime(meta.join_fetched_at);
                  const statusText = meta.join_status_text || (joinDetected ? 'Detected in the Telegram members snapshot.' : 'Waiting for the Telegram sync.');
                  const missingLink = !linkedHandle && !linkedId;
                  const statusColor = missingLink ? '#ff8080' : (joinDetected ? '#8ef5b5' : '#ffb300');
                  const showPrimaryAction = isQuestActionVisible(normalizedStatus, rewardGranted);
                  const primaryDisabled = missingLink;
                  const primaryLabel = missingLink ? 'Link Telegram first' : 'Check now';
                  return wrapQuestCard(
                    <>
                      <h4>Quest 2-2 · Join Telegram group chat</h4>
                      <div className="assistant-meta">Auto-checks with your Quest 1-2 linked Telegram account — no manual proof needed.</div>
                      {highlightNote}
                      <div className="assistant-subtle" style={{ marginTop: 6 }}>Reward: {rewardBadge}</div>
                      <div className="assistant-subtle" style={{ marginTop: 6 }}>
                        Linked: {linkedHandle ? <strong>@{linkedHandle}</strong> : 'Link via Quest 1-2'}
                        {linkedId ? ` · id ${linkedId}` : ''}
                        {' · '}Target:{' '}
                        {targetHandle ? (
                          <a href={targetUrl} target="_blank" rel="noopener noreferrer">
                            @{targetHandle}
                          </a>
                        ) : (
                          'Not set'
                        )}
                      </div>
                      <div className="assistant-subtle" style={{ marginTop: 4, color: statusColor }}>
                        {statusText}
                      </div>
                      {(joinFetched || lastIndexed || lastChecked) && (
                        <div className="assistant-subtle" style={{ marginTop: 4 }}>
                          {joinFetched ? `Detected: ${joinFetched}` : ''}
                          {joinFetched && (lastIndexed || lastChecked) ? ' · ' : ''}
                          {lastIndexed ? `Indexed: ${lastIndexed}` : ''}
                          {lastIndexed && lastChecked ? ' · ' : ''}
                          {lastChecked ? `Checked: ${lastChecked}` : ''}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                        <a className="assistant-btn secondary" href={targetUrl} target="_blank" rel="noopener noreferrer">
                          Open Telegram
                        </a>
                        {showPrimaryAction && (
                          <button className="assistant-btn" disabled={primaryDisabled} onClick={() => verifyQuest('quest2_telegram_join', {})}>
                            {primaryLabel}
                          </button>
                        )}
                        {renderQuestRewardAction('quest2_telegram_join', disabled, { showButton: canClaim, showMessageWhenHidden: true, hideMessageOnSuccess: rewardGranted })}
                        {rewardCompletion}
                      </div>
                      {missingLink && (
                        <div className="assistant-subtle" style={{ marginTop: 4, color: '#ff8080' }}>
                          Complete Quest 1-2 to attach your Telegram account for detection.
                        </div>
                      )}
                    </>
                  );
                }
                case 'quest3_x_engage': {
                  const targetUrl = (meta?.target_tweet_url || questDefs['quest3_x_engage']?.target_tweet_url || 'https://x.com/FlashOrcaCoin/status/1970402419424272666').toString();
                  const actionsMeta = meta?.engage_actions || {};
                  const actions = [
                    { key: 'like', label: 'Like', data: actionsMeta.like, fallback: meta?.liked },
                    { key: 'retweet', label: 'Retweet', data: actionsMeta.retweet, fallback: meta?.retweeted },
                    { key: 'reply', label: 'Reply', data: actionsMeta.reply, fallback: meta?.commented },
                  ].map((a) => ({
                    ...a,
                    done: Boolean(a.data?.done ?? a.fallback),
                    at: formatDateTime(a.data?.fetched_at),
                  }));
                  const lastChecked = formatDateTime(meta?.last_checked_at);
                  const lastIndexed = formatDateTime(meta?.last_indexed_at);
                  const statusText = meta?.status_text || (canClaim ? 'All 3 actions detected.' : 'Waiting for the indexer to confirm your actions.');
                  const missingLink = !(meta?.x_username || quest1Meta?.x_username);
                  const showPrimaryAction = isQuestActionVisible(normalizedStatus, rewardGranted);
                  const primaryDisabled = missingLink;
                  const primaryLabel = missingLink ? 'Link X first' : 'Check now';
                  return wrapQuestCard(
                    <>
                      <h4>Quest3 · Like · Retweet · Reply</h4>
                      <div className="assistant-meta">Auto-checks engagement from your Quest 1-1 linked X account.</div>
                      {highlightNote}
                      <div className="assistant-subtle" style={{ marginTop: 6 }}>Reward: {rewardBadge}</div>
                      <div className="assistant-subtle" style={{ marginTop: 6 }}>
                        Target post:{' '}
                        <a href={targetUrl} target="_blank" rel="noopener">
                          {targetUrl.replace(/^https?:\/\//, '')}
                        </a>
                      </div>
                      <div className="assistant-subtle" style={{ marginTop: 4, color: canClaim ? '#8ef5b5' : '#9ad7ff' }}>
                        {statusText}
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                        {actions.map((a) => (
                          <div key={a.key} style={{ minWidth: 150, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.2)', background: a.done ? 'rgba(91,232,157,0.08)' : 'rgba(255,255,255,0.05)' }}>
                            <div style={{ fontWeight: 700, color: a.done ? '#8ef5b5' : '#ffb300' }}>{a.label}</div>
                            <div className="assistant-subtle" style={{ fontSize: 12 }}>
                              {a.done ? `Detected${a.at ? ` · ${a.at}` : ''}` : 'Not yet detected'}
                            </div>
                          </div>
                        ))}
                      </div>
                      {(lastChecked || lastIndexed) && (
                        <div className="assistant-subtle" style={{ marginTop: 6 }}>
                          {lastChecked ? `Checked: ${lastChecked}` : ''}{lastChecked && lastIndexed ? ' · ' : ''}{lastIndexed ? `Indexed: ${lastIndexed}` : ''}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                        {showPrimaryAction && (
                          <button className="assistant-btn" disabled={primaryDisabled} onClick={() => verifyQuest('quest3_x_engage', {})}>
                            {primaryLabel}
                          </button>
                        )}
                        {renderQuestRewardAction('quest3_x_engage', disabled, { showButton: canClaim, showMessageWhenHidden: true, hideMessageOnSuccess: rewardGranted })}
                        {rewardCompletion}
                      </div>
                      {missingLink && (
                        <div className="assistant-subtle" style={{ marginTop: 4, color: '#ffb300' }}>
                          Complete Quest 1-1 to attach your X account for detection.
                        </div>
                      )}
                    </>
                  );
                }
                case 'quest4_pop_uniq': {
                  const showPrimaryAction = isQuestActionVisible(normalizedStatus, rewardGranted);
                  const quest1 = quests.find((qq) => qq.quest_id === 'quest1_x_link');
                  const questTg = quests.find((qq) => qq.quest_id === 'quest1_telegram_link');
                  const subMeta = (meta as any)?.subtasks || {};
                  const chatCount =
                    typeof (meta as any)?.chat_count === 'number'
                      ? (meta as any).chat_count
                      : typeof subMeta?.chat?.count === 'number'
                        ? subMeta.chat.count
                        : historyCount;
                  const xDone = subMeta?.x_link?.ok ?? (quest1 ? ['completed', 'rewarded'].includes(quest1.status) : false);
                  const tgDone = subMeta?.telegram_link?.ok ?? (questTg ? ['completed', 'rewarded'].includes(questTg.status) : false);
                  const chatDone = subMeta?.chat?.ok ?? (typeof chatCount === 'number' && chatCount > 0);
                  const subTasks = [
                    { key: 'x', label: 'Quest 1-1 · Link X account', done: xDone, detail: xDone ? 'Done' : 'Link X first' },
                    { key: 'tg', label: 'Quest 1-2 · Link Telegram account', done: tgDone, detail: tgDone ? 'Done' : 'Link Telegram first' },
                    { key: 'chat', label: 'Chat with AI Assistant', done: chatDone, detail: `Chat history ${chatCount ?? 0}` },
                  ];
                  const ready = subTasks.every((t) => t.done);
                  const uniqStatus = (meta as any)?.uniq_status || (normalizedStatus === 'completed' ? 'ok' : null);
                  const uniqConflicts = (meta as any)?.uniq_conflicts || {};
                  const uniqMessage = (meta as any)?.uniq_reason || (meta as any)?.message;
                  const lastChecked = formatDateTime((meta as any)?.uniq_checked_at || (meta as any)?.last_checked_at);
                  const primaryLabel = ready ? 'Run uniqueness check' : 'Finish sub-missions first';
                  const rewardButtonDisabled = disabled || normalizedStatus !== 'completed';
                  return wrapQuestCard(
                    <>
                      <h4>Quest4 · Verify PoP Uniq.</h4>
                      <div className="assistant-meta">Complete 3 sub-missions, pass uniqueness, then upgrade to PoP Soft on-chain.</div>
                      {highlightNote}
                      <div className="assistant-subtle" style={{ marginTop: 6 }}>Reward: {rewardBadge}</div>
                      <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                        {subTasks.map((t) => (
                          <div
                            key={t.key}
                            style={{
                              minWidth: 200,
                              padding: '10px 12px',
                              borderRadius: 10,
                              border: '1px solid rgba(255,255,255,0.2)',
                              background: t.done ? 'rgba(91,232,157,0.08)' : 'rgba(255,255,255,0.05)',
                            }}
                          >
                            <div style={{ fontWeight: 700, color: t.done ? '#8ef5b5' : '#ffb300' }}>{t.label}</div>
                            <div className="assistant-subtle" style={{ fontSize: 12 }}>{t.detail}</div>
                          </div>
                        ))}
                      </div>
                      <div className="assistant-subtle" style={{ marginTop: 8, color: uniqStatus === 'failed' ? '#ff8080' : '#9ad7ff' }}>
                        {uniqStatus === 'ok'
                          ? 'Uniq check passed — claim the on-chain Pop Level reward.'
                          : uniqStatus === 'failed'
                            ? uniqMessage || 'Uniq check failed due to overlapping accounts.'
                            : ready
                              ? 'Run the uniqueness check to proceed.'
                              : 'Complete all three sub-missions to enable uniqueness check.'}
                        {lastChecked ? ` · Checked: ${lastChecked}` : ''}
                      </div>
                      {(uniqConflicts?.x_user_ids?.length || uniqConflicts?.telegram_ids?.length) && (
                        <div className="assistant-subtle" style={{ marginTop: 4, color: '#ffb300' }}>
                          {uniqConflicts?.x_user_ids?.length ? `X overlap: ${uniqConflicts.x_user_ids.join(', ')}` : ''}
                          {uniqConflicts?.x_user_ids?.length && uniqConflicts?.telegram_ids?.length ? ' · ' : ''}
                          {uniqConflicts?.telegram_ids?.length ? `Telegram overlap: ${uniqConflicts.telegram_ids.join(', ')}` : ''}
                        </div>
                      )}
                      <div className="actions" style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                        {showPrimaryAction && (
                          <button className="assistant-btn" disabled={disabled || !ready} onClick={() => verifyQuest('quest4_pop_uniq', {})}>
                            {primaryLabel}
                          </button>
                        )}
                        {renderQuestRewardAction('quest4_pop_uniq', rewardButtonDisabled, { showButton: canClaim, showMessageWhenHidden: true, hideMessageOnSuccess: rewardGranted })}
                        {rewardCompletion}
                      </div>
                      {normalizedStatus === 'failed' && (
                        <div className="assistant-subtle" style={{ marginTop: 6, color: '#ff8080' }}>
                          Uniqueness check failed. Please resolve duplicate accounts and try again.
                        </div>
                      )}
                    </>
                  );
                }
                case 'quest5_buy_forca': {
                  const showPrimaryAction = isQuestActionVisible(normalizedStatus, rewardGranted);
                  const txid = meta.txid || meta.reported_txid || meta.reportedTxid;
                  const txHref = explorerTxUrl(txid);
                  const txShort = truncateSig(txid);
                  const buyDetected = Boolean(meta.buy_detected || normalizedStatus === 'completed' || normalizedStatus === 'rewarded');
                  const blockTime = formatDateTime(meta.block_time);
                  const lastIndexed = formatDateTime(meta.last_indexed_at);
                  const lastChecked = formatDateTime(meta.last_checked_at);
                  const statusText =
                    meta.status_text
                    || (buyDetected
                      ? 'Detected a PumpSwap buy in the indexer.'
                      : 'Buy a small amount on the PumpSwap canonical pool and tap Check.');
                  const amountCandidate = meta.amount_forca ?? meta.amount ?? meta.reported_amount;
                  let amountLabel = '';
                  if (typeof amountCandidate === 'number') {
                    amountLabel = `${amountCandidate.toLocaleString(undefined, { maximumFractionDigits: 6 })} $FORCA`;
                  } else if (typeof amountCandidate === 'string' && amountCandidate.trim().length > 0) {
                    amountLabel = `${amountCandidate} $FORCA`;
                  } else if (meta.amount_raw && typeof meta.amount_decimals === 'number') {
                    const parsed = Number(meta.amount_raw);
                    if (Number.isFinite(parsed)) {
                      amountLabel = `${(parsed / 10 ** meta.amount_decimals).toLocaleString(undefined, { maximumFractionDigits: 6 })} $FORCA`;
                    }
                  }
                  return wrapQuestCard(
                    <>
                      <h4>Quest5 · Buy small amount of FORCA</h4>
                      <div className="assistant-meta">Buy on the PumpSwap canonical pool — we auto-detect from the indexer.</div>
                      {highlightNote}
                      <div className="assistant-subtle" style={{ marginTop: 6 }}>Reward: {rewardBadge}</div>
                      <div className="assistant-subtle" style={{ marginTop: 6, color: buyDetected ? '#8ef5b5' : '#9ad7ff' }}>
                        {statusText}
                      </div>
                      <div className="assistant-subtle" style={{ marginTop: 4 }}>
                        {amountLabel || 'Amount: awaiting detection'}
                      </div>
                      <div className="assistant-subtle" style={{ marginTop: 4 }}>
                        {[
                          blockTime ? `Block time: ${blockTime}` : null,
                          lastIndexed ? `Indexed: ${lastIndexed}` : null,
                          lastChecked ? `Checked: ${lastChecked}` : null,
                        ].filter(Boolean).join(' · ')}
                      </div>
                      {txid && (
                        <div className="assistant-subtle" style={{ marginTop: 4 }}>
                          Tx:{' '}
                          <a href={txHref ?? undefined} target="_blank" rel="noopener noreferrer" style={{ color: '#bde3ff' }}>
                            View on Solscan ({txShort})
                          </a>
                        </div>
                      )}
                      <div className="actions" style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                        {showPrimaryAction && (
                          <button className="assistant-btn" disabled={disabled} onClick={() => verifyQuest('quest5_buy_forca', {})}>
                            Check now
                          </button>
                        )}
                        {renderQuestRewardAction('quest5_buy_forca', disabled, { showButton: canClaim, showMessageWhenHidden: true, hideMessageOnSuccess: rewardGranted })}
                        {rewardCompletion}
                      </div>
                    </>
                  );
                }
                case 'quest6_reward_vault': {
                  const showPrimaryAction = isQuestActionVisible(normalizedStatus, rewardGranted);
                  const txid = meta.txid || meta.reported_txid || meta.reportedTxid;
                  const txHref = explorerTxUrl(txid);
                  const txShort = truncateSig(txid);
                  const convertDetected = Boolean(meta.convert_detected || txid);
                  const eventTime = formatDateTime(meta.event_time);
                  const lastIndexed = formatDateTime(meta.last_indexed_at);
                  const lastChecked = formatDateTime(meta.last_checked_at);
                  const statusText =
                    meta.status_text
                    || (convertDetected
                      ? 'Detected Convert to PP in the Reward Vault indexer.'
                      : 'Finish a Convert to PP and tap Check to sync.');
                  const amountRaw = meta.amount_pp_e6 ?? meta.amount ?? null;
                  let amountLabel = '';
                  if (amountRaw !== null && amountRaw !== undefined) {
                    try {
                      amountLabel = formatAmount(BigInt(amountRaw), 6, 'PP');
                    } catch {
                      amountLabel = String(amountRaw);
                    }
                  }
                  return wrapQuestCard(
                    <>
                      <h4>Quest6 · Convert PP</h4>
                      <div className="assistant-meta">Run a Convert to PP in Reward Vault — we auto-detect it from the indexer.</div>
                      {highlightNote}
                      <div className="assistant-subtle" style={{ marginTop: 6 }}>Reward: {rewardBadge}</div>
                      <div className="assistant-subtle" style={{ marginTop: 6, color: convertDetected ? '#8ef5b5' : '#9ad7ff' }}>
                        {statusText}
                      </div>
                      <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                        <div className="assistant-subtle">
                          Tx: {txid ? (
                            txHref ? (
                              <a href={txHref} target="_blank" rel="noopener noreferrer">{txShort}</a>
                            ) : txShort
                          ) : 'Pending'}
                        </div>
                        <div className="assistant-subtle">Event: {eventTime || 'Pending'}</div>
                        <div className="assistant-subtle">
                          Indexed: {lastIndexed || 'Pending'}
                          {lastChecked ? ` · Checked: ${lastChecked}` : ''}
                        </div>
                        {amountLabel && (
                          <div className="assistant-subtle">Amount: {amountLabel}</div>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                        {showPrimaryAction && (
                          <button className="assistant-btn" disabled={disabled} onClick={() => verifyQuest('quest6_reward_vault', {})}>
                            Check now
                          </button>
                        )}
                        <button className="assistant-btn secondary" onClick={() => setCurrentTab('snapshot')}>
                          Open Reward Vault
                        </button>
                        {renderQuestRewardAction('quest6_reward_vault', disabled, { showButton: canClaim, showMessageWhenHidden: true, hideMessageOnSuccess: rewardGranted })}
                        {rewardCompletion}
                      </div>
                      <div className="assistant-subtle" style={{ marginTop: 6 }}>
                        Convert actions triggered below auto-report; you can re-check anytime.
                      </div>
                    </>
                  );
                }
                default:
                  return wrapQuestCard(
                    <>
                      <h4>{def?.title || q.quest_id}</h4>
                      <div className="assistant-meta">Status: {q.status}</div>
                      {highlightNote}
                      <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
                        {renderQuestRewardAction(q.quest_id, disabled, { showButton: canClaim, showMessageWhenHidden: true, hideMessageOnSuccess: rewardGranted })}
                        {rewardCompletion}
                      </div>
                    </>
                  );
              }
            };
            return <Section key={`sec-${q.quest_id}`} />;
          })}
        </div>
      )}
      {showBalanceAll && connected && currentTab === 'snapshot' && (
        <>
          <div className="snapshot-section" style={{ marginTop: 12 }}>
            <strong>SOL:</strong>{' '}
            {sol === null ? '-' : sol.toLocaleString(undefined, { maximumFractionDigits: 6 })}
          </div>
          <div className="snapshot-section">
            <strong>SPL Tokens:</strong>
            {spl.length === 0 ? (
              <div style={{ opacity: .7 }}>No token balances</div>
            ) : (
              <ul>
                {spl.slice(0, 20).map(t => (
                  <li key={`${t.mint}`}>
                    <code>{t.mint}</code> — {t.uiAmountString}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
      {connected && currentTab === 'snapshot' && (
        <div
          className="snapshot-section"
          style={{
            marginTop: 16,
            padding: 14,
            borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'rgba(16,19,26,0.35)',
            display: 'grid',
            gap: 8,
          }}
        >
          <div className="snapshot-ally-header" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
            <strong>Reward Vault Snapshot</strong>
            <code style={{ fontSize: 12, opacity: .65 }}>{rewardProgramId}</code>
          </div>
          {rewardLoading ? (
            <div style={{ opacity: .8 }}>Loading reward data...</div>
          ) : rewardError ? (
            <div style={{ color: '#ff8080' }}>Failed to load: {rewardError}</div>
          ) : (
              <>
                {vaultStateAccount ? (
                  <div
                    style={{
                      display: 'grid',
                      gap: 6,
                      gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                      marginBottom: 4,
                    }}
                  >
                    <div style={{ fontSize: 12, opacity: .8 }}>
                      <strong>Fee (C):</strong> {formatBps(vaultStateAccount.feeCBps)}
                    </div>
                    <div style={{ fontSize: 12, opacity: .8 }}>
                      <strong>Tax (D):</strong> {formatBps(vaultStateAccount.taxDBps)}
                    </div>
                    <div style={{ fontSize: 12, opacity: .8 }}>
                      <strong>Margin (B):</strong> {formatBps(vaultStateAccount.marginBBps)}
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, opacity: .65, marginBottom: 4 }}>
                    Vault settings loading…
                  </div>
                )}
                <div style={{ display: 'grid', gap: 4 }}>
                <div>
                  <strong>SOL Balance:</strong>{' '}
                  {sol === null ? '-' : `${sol.toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL`}
                </div>
                <div>
                  <strong>$FORCA Balance:</strong>{' '}
                  {forcaTokenBalance
                    ? `${forcaTokenBalance.uiAmountString} $FORCA`
                    : 'None'}
                  {forcaMint ? (
                    <code style={{ marginLeft: 8, fontSize: 11, opacity: .6 }}>{forcaMint}</code>
                  ) : null}
                </div>
              </div>
            <div>
              <strong>PoP Level:</strong>{' '}
              {rewardSnapshot?.popProfile
                ? `${rewardSnapshot.popProfile.levelLabel} (index ${rewardSnapshot.popProfile.levelIndex})`
                : 'Not set'}
            </div>
            <div
              style={{
                marginTop: 6,
                padding: 10,
                borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(11,14,20,0.6)',
                display: 'grid',
                gap: 6,
              }}
            >
              <div style={{ fontWeight: 600 }}>PoP Level on-chain update</div>
              <div className="assistant-subtle" style={{ fontSize: 12 }}>
                After completing Quest4 (PoP Uniq), record your Pop Level on-chain and review the tx.
              </div>
              {renderQuestRewardAction('quest4_pop_uniq', !quest4ReadyForClaim, {
                showButton: quest4ReadyForClaim && !quest4RewardGranted,
                showMessageWhenHidden: true,
              })}
              {!quest4ReadyForClaim && (
                <div className="assistant-subtle" style={{ color: '#ffb347' }}>
                  This activates after completing the Quest4 uniqueness check.
                </div>
              )}
              {quest4Doc?.reward_tx_sig && (
                <div className="assistant-subtle" style={{ color: '#8ef5b5' }}>
                  Recent tx:{' '}
                  <a
                    href={explorerTxUrl(quest4Doc.reward_tx_sig) ?? undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: '#bde3ff' }}
                  >
                    View on Solscan ({truncateSig(quest4Doc.reward_tx_sig)})
                  </a>
                </div>
              )}
            </div>
            {!popAllocateAllowed && (
              <div
                style={{
                  fontSize: 12,
                  color: '#ffb347',
                  background: 'rgba(255, 179, 71, 0.12)',
                  border: '1px solid rgba(255, 179, 71, 0.35)',
                  padding: '8px 10px',
                  borderRadius: 10,
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 8,
                  alignItems: 'center',
                }}
              >
                New RP allocations require PoP Soft or Strong. Existing RP can still be claimed.
                <button
                  type="button"
                  className="assistant-btn secondary"
                  style={{ padding: '4px 10px', fontSize: 12 }}
                  onClick={() => setCurrentTab('quests')}
                >
                  Go to Quests
                </button>
              </div>
            )}
            {popParamsInfo && vaultStateAccount && (
              <div style={{ fontSize: 12, opacity: .7 }}>
                PoP params{popParamsAlly?.label ? ` (${popParamsAlly.label})` : ''}: soft cap {formatMicroUsd(popParamsInfo.capUsd)} per day · Cooldown:{' '}
                {popParamsInfo.cooldownSecs > 0n ? `${popParamsInfo.cooldownSecs} sec` : 'none'} · PoP FORCA/USD:{' '}
                {vaultStateAccount.verifyPrices && !vaultStateAccount.useMockOracle
                  ? 'oracle/DEX derived'
                  : formatMicroUsd(vaultStateAccount.forcaUsdE6, 6)}
              </div>
            )}
            {rewardSnapshot?.popProfile?.lastSetTs && (
              <div style={{ fontSize: 12, opacity: .65 }}>
                Last updated: {formatTimestamp(rewardSnapshot.popProfile.lastSetTs)}
              </div>
            )}
            {quoteInfo ? (
              <div style={{ fontSize: 12, opacity: .7 }}>
                Price: 1 $FORCA ≈ {formatMicroUsd(quoteInfo.forcaUsdE6, 4)} · 1 SOL ≈ {formatMicroUsd(quoteInfo.solPriceUsdE6, 2)} (updated{' '}
                {new Date(quoteInfo.updatedAt).toLocaleTimeString(undefined, { hour12: false })})
              </div>
            ) : quoteError ? (
              <div style={{ fontSize: 12, color: '#ff8080' }}>
                Price feed unavailable: {quoteError}
              </div>
            ) : null}
            {vaultStateAccount && (
              <div style={{ fontSize: 11, opacity: .6 }}>
                {vaultStateAccount.verifyPrices && !vaultStateAccount.useMockOracle
                  ? 'PoP pricing uses oracle/DEX-derived FORCA/USD (verified on-chain).'
                  : vaultStateAccount.useMockOracle
                    ? `PoP pricing uses manual FORCA/USD (${formatMicroUsd(vaultStateAccount.forcaUsdE6, 6)}) in mock/emergency mode.`
                    : `PoP pricing uses stored FORCA/USD (${formatMicroUsd(vaultStateAccount.forcaUsdE6, 6)}) because verify_prices=false.`}
              </div>
            )}
            <div style={{ marginTop: 4 }}>
              <strong>Allies</strong>
            </div>
            {rewardVaultConfig.allies.length === 0 ? (
              <div style={{ opacity: .7 }}>
                No ally configuration found. Check VITE_REWARD_VAULT_ALLIES.
              </div>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 12 }}>
                {(rewardSnapshot?.ledgers ?? []).map((ledger) => {
                    const allyMintKey = ledger.ally.mintAddress;
                    const allyState = getActionState(allyMintKey);
                    const convertAmountParsed = allyState.convertAmount
                      ? parseDecimalAmount(allyState.convertAmount, FORCA_DECIMALS)
                      : null;
                    const claimAmountParsed = allyState.claimAmount
                      ? parseDecimalAmount(allyState.claimAmount, FORCA_DECIMALS)
                      : null;
                    const availableConvert = forcaTokenBalance
                      ? parseDecimalAmount(
                        forcaTokenBalance.uiAmountString,
                        Number(forcaTokenBalance.decimals ?? FORCA_DECIMALS),
                      )
                      : null;
                    const convertInsufficient =
                      convertAmountParsed !== null &&
                      availableConvert !== null &&
                      convertAmountParsed > availableConvert;
                    const convertPending = allyState.convertStatus === 'pending';
                    const claimPending = allyState.claimStatus === 'pending';
                    const convertOracleDisabled = Boolean(vaultStateAccount && !vaultStateAccount.verifyPrices);
                    const convertDisabled =
                      convertPending ||
                      !publicKey ||
                      !convertAmountParsed ||
                      convertAmountParsed === 0n ||
                      convertInsufficient ||
                      convertOracleDisabled;
                    const claimDisabled =
                      claimPending ||
                      !publicKey ||
                      !ledger.exists ||
                      !claimAmountParsed ||
                      claimAmountParsed === 0n ||
                      claimAmountParsed > ledger.rpClaimable;
                    const convertStatusColor =
                      allyState.convertStatus === 'error'
                        ? '#ff8080'
                        : allyState.convertStatus === 'success'
                          ? '#8ef5b5'
                          : '#cbd5f5';
                    const claimStatusColor =
                      allyState.claimStatus === 'error'
                        ? '#ff8080'
                        : allyState.claimStatus === 'success'
                          ? '#8ef5b5'
                          : '#cbd5f5';
                    const allyAccount = allyAccountMap[allyMintKey] ?? null;
                    const allyBenefitDescription = allyAccount
                      ? `${getBenefitModeLabel(allyAccount.benefitMode)} · ${formatBps(allyAccount.benefitBps)}`
                      : 'Benefit info loading…';
                    const vaultBalanceText = allyAccount
                      ? formatAmount(allyAccount.balanceForca, FORCA_DECIMALS, 'FORCA')
                      : '—';
                    const rpReservedText = allyAccount
                      ? formatAmount(allyAccount.rpReserved, FORCA_DECIMALS, 'FORCA')
                      : '—';
                    const claimableText = formatAmount(ledger.rpClaimable, FORCA_DECIMALS, 'FORCA');
                    const convertUsdMicro =
                      convertAmountParsed !== null && quoteInfo
                        ? (convertAmountParsed * quoteInfo.forcaUsdE6) / MICRO_SCALE
                        : null;
                    const capInfo = getPopCapInfo(allyMintKey);
                    const { effectiveClaimable, remainingUsd, remainingForca } = computeEffectiveClaimable(ledger);
                    const isConvertHighlighted =
                      snapshotFocus?.allyMint === allyMintKey && snapshotFocus?.action === 'convert';
                    const isClaimHighlighted =
                      snapshotFocus?.allyMint === allyMintKey && snapshotFocus?.action === 'claim';
                    return (
                      <li
                        key={ledger.address.toBase58()}
                        style={{
                          display: 'grid',
                          gap: 8,
                          paddingBottom: 8,
                          borderBottom: '1px solid rgba(255,255,255,0.06)',
                        }}
                      >
                        <div className="snapshot-ally-header" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'baseline' }}>
                          <span>{ledger.ally.label}</span>
                          <code style={{ fontSize: 11, opacity: .6 }}>{ledger.ally.mintAddress}</code>
                        </div>
                        <div style={{ fontSize: 12, opacity: .65 }}>
                          Benefit: {allyBenefitDescription}
                        </div>
                        {ledger.exists ? (
                          <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                              <span>PP {formatAmount(ledger.ppBalance, FORCA_DECIMALS)}</span>
                              <span>RP {claimableText}</span>
                            </div>
                            <div style={{ fontSize: 12, opacity: .6 }}>
                              Created: {formatTimestamp(ledger.createdTs)} · Updated: {formatTimestamp(ledger.updatedTs)}
                            </div>
                            <div style={{ fontSize: 12, opacity: .65 }}>
                              Current HWM: {formatAmount(ledger.hwmClaimed, FORCA_DECIMALS, 'FORCA')} · Tax HWM: {formatAmount(ledger.taxHwm, FORCA_DECIMALS, 'FORCA')}
                            </div>
                          </div>
                        ) : (
                          <div style={{ opacity: .7, fontSize: 13 }}>
                            User ledger not initialized yet — first convert will create it.
                          </div>
                        )}
                        <div style={{ fontSize: 12, opacity: .6 }}>
                          Ally vault balance: {vaultBalanceText} · RP reserved: {rpReservedText}
                        </div>
                        <div
                          ref={(el) => {
                            if (!snapshotActionRefs.current[allyMintKey]) snapshotActionRefs.current[allyMintKey] = {};
                            snapshotActionRefs.current[allyMintKey].convert = el;
                          }}
                          className={`snapshot-action-card${isConvertHighlighted ? ' is-highlighted' : ''}`}
                        >
                          {isConvertHighlighted && <div className="snapshot-focus-badge">Assistant</div>}
                          <div style={{ fontSize: 12, opacity: .8 }}>Convert $FORCA → PP</div>
                          <div className="snapshot-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            <input
                              value={allyState.convertAmount}
                              onChange={(e) => handleConvertInputChange(allyMintKey, e.target.value)}
                              placeholder="Amount ($FORCA)"
                              style={{
                                flex: '1 1 160px',
                                minWidth: 140,
                                padding: '6px 10px',
                                borderRadius: 6,
                                border: '1px solid rgba(255,255,255,0.25)',
                                background: 'rgba(12,15,22,0.65)',
                                color: '#fff',
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => handleConvertMax(allyMintKey)}
                              disabled={convertPending || !forcaTokenBalance}
                              style={{
                                padding: '6px 10px',
                                borderRadius: 6,
                                border: '1px solid rgba(255,255,255,0.2)',
                                background: 'rgba(255,255,255,0.08)',
                                color: '#fff',
                                cursor: convertPending || !forcaTokenBalance ? 'not-allowed' : 'pointer',
                                opacity: convertPending || !forcaTokenBalance ? 0.6 : 1,
                              }}
                            >
                              Max
                            </button>
                            <button
                              type="button"
                              onClick={() => handleConvertSubmit(ledger)}
                              disabled={convertDisabled}
                              style={{
                                padding: '6px 14px',
                                borderRadius: 6,
                                border: 'none',
                                background: convertDisabled ? 'rgba(37,99,235,0.35)' : '#2563eb',
                                color: '#fff',
                                cursor: convertDisabled ? 'not-allowed' : 'pointer',
                                opacity: convertDisabled ? 0.7 : 1,
                              }}
                            >
                              {convertPending ? 'Converting…' : 'Convert'}
                            </button>
                          </div>
                          <div style={{ fontSize: 12, opacity: .65 }}>
                            Available: {forcaTokenBalance ? `${forcaTokenBalance.uiAmountString} $FORCA` : '0'}
                          </div>
                          {convertUsdMicro !== null && convertAmountParsed !== null && convertAmountParsed > 0n && quoteInfo && (
                            <div style={{ fontSize: 12, opacity: .7 }}>
                              ≈ {formatMicroUsd(convertUsdMicro, 2)}
                            </div>
                          )}
                          {convertInsufficient && (
                            <div style={{ fontSize: 12, color: '#ff8080' }}>
                              Amount exceeds wallet balance
                            </div>
                          )}
                          {convertOracleDisabled && (
                            <div style={{ fontSize: 12, color: '#ffb347' }}>
                              Convert disabled: verify_prices is off. Ask admin to enable oracle verification.
                            </div>
                          )}
                          {allyState.convertMessage && (
                            <div style={{ fontSize: 12, color: convertStatusColor, display: 'grid', gap: 4 }}>
                              <span>{allyState.convertMessage}</span>
                              {allyState.convertTxSig && (
                                <a
                                  href={explorerTxUrl(allyState.convertTxSig) ?? undefined}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{ color: '#bde3ff' }}
                                >
                                  View on Solscan ({truncateSig(allyState.convertTxSig)})
                                </a>
                              )}
                            </div>
                          )}
                          {showDebug && (allyState.convertDebug?.length ?? 0) > 0 && (
                            <details open style={{ fontSize: 11, opacity: .7 }}>
                              <summary>Debug</summary>
                              <ul style={{ margin: 0, paddingLeft: 16 }}>
                                {allyState.convertDebug!.map((l, i) => (
                                  <li key={i}>{l}</li>
                                ))}
                              </ul>
                            </details>
                          )}
                        </div>
                        <div
                          ref={(el) => {
                            if (!snapshotActionRefs.current[allyMintKey]) snapshotActionRefs.current[allyMintKey] = {};
                            snapshotActionRefs.current[allyMintKey].claim = el;
                          }}
                          className={`snapshot-action-card${isClaimHighlighted ? ' is-highlighted' : ''}`}
                        >
                          {isClaimHighlighted && <div className="snapshot-focus-badge">Assistant</div>}
                          <div style={{ fontSize: 12, opacity: .8 }}>Claim RP (receives $FORCA)</div>
                          <div className="snapshot-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            <input
                              value={allyState.claimAmount}
                              onChange={(e) => handleClaimInputChange(allyMintKey, e.target.value)}
                              placeholder="Amount (FORCA)"
                              style={{
                                flex: '1 1 160px',
                                minWidth: 140,
                                padding: '6px 10px',
                                borderRadius: 6,
                                border: '1px solid rgba(255,255,255,0.25)',
                                background: 'rgba(12,15,22,0.65)',
                                color: '#fff',
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => handleClaimMax(allyMintKey, ledger)}
                              disabled={claimPending || ledger.rpClaimable === 0n}
                              style={{
                                padding: '6px 10px',
                                borderRadius: 6,
                                border: '1px solid rgba(255,255,255,0.2)',
                                background: 'rgba(255,255,255,0.08)',
                                color: '#fff',
                                cursor: claimPending || ledger.rpClaimable === 0n ? 'not-allowed' : 'pointer',
                                opacity: claimPending || ledger.rpClaimable === 0n ? 0.6 : 1,
                              }}
                            >
                              Max
                            </button>
                            <button
                              type="button"
                              onClick={() => handleClaimSubmit(ledger)}
                              disabled={claimDisabled}
                              style={{
                                padding: '6px 14px',
                                borderRadius: 6,
                                border: 'none',
                                background: claimDisabled ? 'rgba(16,185,129,0.35)' : '#10b981',
                                color: '#0b1120',
                                cursor: claimDisabled ? 'not-allowed' : 'pointer',
                                opacity: claimDisabled ? 0.6 : 1,
                              }}
                            >
                              {claimPending ? 'Claiming…' : 'Claim'}
                            </button>
                          </div>
                          <div style={{ fontSize: 12, opacity: .65 }}>
                            Available: {claimableText}
                            {!ledger.exists ? ' (ledger not initialized)' : ''}
                          </div>
                          {capInfo && remainingUsd !== null && remainingForca !== null && (
                            <div style={{ fontSize: 11, opacity: .7, display: 'grid', gap: 2 }}>
                              <div>
                                PoP cap/day (Suspicious/Soft): {formatAmount(capInfo.capForca, FORCA_DECIMALS, '$FORCA')} ≈ {formatMicroUsd(capInfo.capUsd, 2)}
                              </div>
                              <div>
                                Remaining today: {formatAmount(remainingForca, FORCA_DECIMALS, '$FORCA')} (≈ {formatMicroUsd(remainingUsd, 2)}) · Effective max now: {formatAmount(effectiveClaimable, FORCA_DECIMALS, '$FORCA')}
                              </div>
                            </div>
                          )}
                          {claimAmountParsed !== null && claimAmountParsed > ledger.rpClaimable && (
                            <div style={{ fontSize: 12, color: '#ff8080' }}>
                              Amount exceeds claimable balance
                            </div>
                          )}
                          {allyState.claimMessage && (
                            <div style={{ fontSize: 12, color: claimStatusColor, display: 'grid', gap: 4 }}>
                              <span>{allyState.claimMessage}</span>
                              {allyState.claimTxSig && (
                                <a
                                  href={explorerTxUrl(allyState.claimTxSig) ?? undefined}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{ color: '#bde3ff' }}
                                >
                                  View on Solscan ({truncateSig(allyState.claimTxSig)})
                                </a>
                              )}
                            </div>
                          )}
                          {showDebug && (allyState.claimDebug?.length ?? 0) > 0 && (
                            <details open style={{ fontSize: 11, opacity: .7 }}>
                              <summary>Debug</summary>
                              <ul style={{ margin: 0, paddingLeft: 16 }}>
                                {allyState.claimDebug!.map((l, i) => (
                                  <li key={i}>{l}</li>
                                ))}
                              </ul>
                            </details>
                          )}
                        </div>
                      </li>
                    );
                  })}
                  {rewardSnapshot?.ledgers?.length === 0 && (
                    <li style={{ opacity: .7, fontSize: 13 }}>No ledgers to display.</li>
                  )}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {showDebug && (
        <details style={{ marginTop: 16, background: '#0f1117', color: '#e5e7eb', border: '1px solid #1f2937', borderRadius: 8, padding: 12 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Debug: UA / Referrer / Env</summary>
          <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
            <div>
              <div style={{ opacity: .8, fontSize: 12 }}>navigator.userAgent</div>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>{ua}</pre>
            </div>
            <div>
              <div style={{ opacity: .8, fontSize: 12 }}>document.referrer</div>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>{referrer || '(empty)'}</pre>
            </div>
            <div style={{ display: 'grid', gap: 4, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' }}>
              <div>env.isMobile: {String(env.isMobile)}</div>
              <div>env.isIOS: {String(env.isIOS)}</div>
              <div>env.isSafari: {String(env.isSafari)}</div>
              <div>env.inAppWalletUA: {String(env.inAppWalletUA)}</div>
              <div>env.hasInjectedProvider: {String(env.hasInjectedProvider)}</div>
              <div>connected: {String(connected)}</div>
              <div>primaryIsBrowse: {String(primaryIsBrowse)}</div>
            </div>
          </div>
        </details>)}

    </div>
  );
}
