import { useState, useEffect } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { Connection, SystemProgram, Transaction, ComputeBudgetProgram, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

import type { Adapter } from '@solana/wallet-adapter-base';
import type {
  SolanaSignInInput,
  SolanaSignInOutput,
} from '@solana/wallet-standard-features';

import { WalletMultiButton, useWalletModal } from '@solana/wallet-adapter-react-ui';

//type BrowseWallet = 'phantom' | 'solflare' | 'backpack';

type BrowseWallet =
  | 'phantom' | 'solflare' | 'backpack'
  | 'metamask' | 'trust' | 'bitget' | 'exodus';

const TRUSTWALLET_COIN_ID =
  (import.meta.env.VITE_TRUSTWALLET_COIN_ID || '501').toString(); // 501 = Solana

// very light UA check; adequate for deciding QR vs redirect
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
// MetaMask app-link requires NO scheme in path: /dapp/<host+path>
const toMetaMaskDappPath = (absUrl: string) => {
  const u = new URL(absUrl);
  return `${u.host}${u.pathname}${u.search}${u.hash}`;
};

function buildBrowseLink(wallet: BrowseWallet, url: string, ref: string) {
  switch (wallet) {
    case 'phantom':
      return `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(ref)}`;
    case 'solflare':
      return `https://solflare.com/ul/v1/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(ref)}`;
    case 'backpack':
      return `https://backpack.app/ul/v1/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(ref)}`;
    case 'metamask':
      // do NOT encode whole URL; pass host+path only
      return `https://metamask.app.link/dapp/${toMetaMaskDappPath(url)}`;
    case 'trust':
      // SLIP-0044 coin id: Solana=501, ETH=60 등
      return `https://link.trustwallet.com/open_url?coin_id=${encodeURIComponent(TRUSTWALLET_COIN_ID)}&url=${encodeURIComponent(url)}`;
    case 'bitget':
    case 'exodus':
      // 두 지갑은 공개 'browse' 딥링크가 안정적이지 않음 → QR/복사 fallback
      return url;
    default:
      throw new Error('unknown wallet');
  }
}

// 시도 횟수별 tip 사다리(마이크로-람포츠/1 CU)
const tipFor = (attempt: number) => [100_000, 300_000, 1_000_000][attempt] ?? 300_000;
// 필요시 CU 상한도 명시(안전빵)
const CU_LIMIT = 1_000_000;


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

  const { connected, connecting, publicKey, connect, disconnect, sendTransaction, signMessage, wallet } = useWallet();
  const { setVisible: setWalletModalVisible } = useWalletModal();

  const [qr, setQr] = useState<{ wallet: BrowseWallet; url: string } | null>(null);

  const [showBrowseModal, setShowBrowseModal] = useState(false);

  const [sol, setSol] = useState<number | null>(null);
  const [spl, setSpl] = useState<Array<{
    mint: string;
    uiAmount: number;
    uiAmountString: string;
    decimals: number;
  }>>([]);

  // Use the same Connection instance provided by Wallet Adapter.
  // This prevents endpoint mismatches between the provider and our app code.
  const { connection } = useConnection();

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
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (!d) return;
      if (d === 'open-wallet' || (typeof d === 'object' && d.type === 'open-wallet')) {
        setWalletModalVisible(true);
      } else if (d === 'connect-wallet' || (typeof d === 'object' && d.type === 'connect-wallet')) {
        (window as any).flashorcaWallet?.connect?.();
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [setWalletModalVisible]);

  useEffect(() => {
    if (wallet && !connected && !connecting) {
      connect().catch((e) => console.warn('auto-connect failed:', e));
    }
  }, [wallet, connected, connecting, connect]);

  // App.tsx (적절한 위치에 추가 — autoConnect useEffect 바로 아래 등)
  useEffect(() => {
    if (connected) {
      setWalletModalVisible(false); // 연결되면 모달 닫기
      try {
        window.dispatchEvent(new CustomEvent('flashorca-wallet-connected', {
          detail: { address: publicKey?.toBase58() || null }
        }));
      } catch { }
    } else {
      try {
        window.dispatchEvent(new Event('flashorca-wallet-disconnected'));
      } catch { }
    }
  }, [connected, publicKey?.toBase58(), setWalletModalVisible]);

  // const handleConnect = async () => { if (!connected) await connect(); };


  const handleOpenInWallet = async (wallet: BrowseWallet) => {
    const targetUrl = window.location.href;
    const refUrl = (import.meta.env.VITE_APP_REF || window.location.origin).toString();

    let deeplink = '';
    try {
      const mod: any = await import('@tonyboyle/solana-wallet-universal-links-generator');
      if (typeof mod.buildBrowseLink === 'function') {
        deeplink = mod.buildBrowseLink(wallet, targetUrl, refUrl);
      } else if (typeof mod.buildUniversalLink === 'function') {
        deeplink = mod.buildUniversalLink(wallet, targetUrl, refUrl);
      } else if (typeof mod.default === 'function') {
        deeplink = mod.default(wallet, targetUrl, refUrl);
      }
    } catch { /* 미설치면 폴백 사용 */ }

    if (!deeplink) deeplink = buildBrowseLink(wallet, targetUrl, refUrl);

    // browse 링크가 확실치 않은 지갑은 QR fallback 유도
    if ((wallet === 'bitget' || wallet === 'exodus') && !isMobile) {
      setQr({ wallet, url: deeplink });
      return;
    }

    if (isMobile) window.location.href = deeplink;
    else setQr({ wallet, url: deeplink });
  };

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
      alert(ok ? '✅ SIWS success' : '❌ SIWS verify failed');
    } else {
      // ③ 폴백: 레거시 signMessage
      await handleLegacySignIn();
    }
  };

  // 2) 레거시 nonce 메시지 서명 (fallback)
  const handleLegacySignIn = async () => {
    if (!signMessage || !publicKey) return alert('지갑이 signMessage 미지원');
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
    alert(ok ? '✅ Legacy sign-in success' : '❌ Legacy verify failed');
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

  // 지갑이 바뀌면 즉시 갱신
  useEffect(() => {
    let aborted = false;
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
  }, [publicKey?.toBase58(), connection]);

  // --- Environment detection for primary action (Browse vs Connect) ---
  const [env, setEnv] = useState({
    isMobile: /iPhone|iPad|iPod|Android/i.test(navigator.userAgent),
    isIOS: /iPhone|iPad|iPod/i.test(navigator.userAgent),
    isSafari: /Safari/i.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/i.test(navigator.userAgent),
    inAppWalletUA: /Phantom|Solflare|Backpack/i.test(navigator.userAgent),
    hasInjectedProvider: false,
  });
  useEffect(() => {
    const w: any = window as any;
    const injected = !!(
      (w.solana && (w.solana.isPhantom || w.solana.isSolflare || w.solana.isBackpack)) ||
      (w.phantom && w.phantom.solana) ||
      (w.backpack && w.backpack.solana)
    );
    setEnv((e) => ({ ...e, hasInjectedProvider: injected }));
  }, []);
  // 조건: 모바일 사파리/모바일 & (인앱브라우저 아님) & (주입 지갑 없음) → Browse를 기본 동작으로
  const primaryIsBrowse =
    !connected &&
    ((env.isIOS && env.isSafari && !env.inAppWalletUA && !env.hasInjectedProvider) ||
      (env.isMobile && !env.inAppWalletUA && !env.hasInjectedProvider));

  return (
    <div style={{ padding: 24, display: 'grid', gap: 12 }}>
      <h2>$FORCA Reward Claim</h2>
      {connected ? (
        <WalletMultiButton />
      ) : primaryIsBrowse ? null : (
        <WalletMultiButton>Connect Wallet</WalletMultiButton>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        {!connected && primaryIsBrowse ? (
          <button onClick={() => setShowBrowseModal(true)} style={{ padding: 10, borderRadius: 8, fontWeight: 600 }}>
            Open in Wallet
          </button>
        ) : null}
        {!connected && !primaryIsBrowse ? (
          <small style={{ alignSelf: 'center', opacity: .7 }}>
            or&nbsp;<a href="#" onClick={(e) => { e.preventDefault(); setShowBrowseModal(true); }}>Open in Wallet</a>
          </small>
        ) : null}
      </div>

      {/* <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <button onClick={() => setShowBrowseModal(true)}>
          Open in Wallet
        </button>
        <button onClick={() => handleOpenInWallet('phantom')}>Open in Phantom (QR)</button>
        <button onClick={() => handleOpenInWallet('solflare')}>Open in Solflare (QR)</button>
        <button onClick={() => handleOpenInWallet('backpack')}>Open in Backpack (QR)</button>
      </div> */}
      {/* <button disabled={connecting || connected} onClick={handleConnect}>
        {connecting ? 'Connecting...' : connected ? 'Connected' : 'Connect Wallet'}
      </button> */}

      {connected && (
        <>
          <div>Public Key: {publicKey?.toBase58()}</div>
          <button onClick={handleSIWS}>Sign-In with Solana (SIWS)</button>
          <button onClick={handleLegacySignIn}>Legacy Sign-In (nonce + signMessage)</button>
          <button onClick={handleTx}>Send 1 lamport (self)</button>
          <button onClick={() => disconnect()}>Disconnect</button>
        </>
      )}
      {connected && (
        <>
          <div style={{ marginTop: 12 }}>
            <strong>SOL:</strong>{' '}
            {sol === null ? '-' : sol.toLocaleString(undefined, { maximumFractionDigits: 6 })}
          </div>
          <div>
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

      {showBrowseModal && (
        <div
          onClick={() => setShowBrowseModal(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
            display: 'grid', placeItems: 'center', zIndex: 999
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: '#111', color: '#fff', padding: 16, borderRadius: 14, width: 380, boxShadow: '0 10px 30px rgba(0,0,0,0.4)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0, fontSize: 18 }}>Open in Wallet</h3>
              <button onClick={() => setShowBrowseModal(false)} style={{ background: 'transparent', color: '#aaa' }}>✕</button>
            </div>
            <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
              <button onClick={() => { setShowBrowseModal(false); handleOpenInWallet('phantom'); }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, borderRadius: 8, background: '#2b2b2b', color: '#fff' }}>
                <span style={{ width: 28, height: 28, borderRadius: 6, background: '#7c4dff', display: 'grid', placeItems: 'center' }}>🟣</span>
                <span>Phantom</span>
                <span style={{ marginLeft: 'auto', opacity: .6, fontSize: 12 }}>In-app browser</span>
              </button>
              <button onClick={() => { setShowBrowseModal(false); handleOpenInWallet('solflare'); }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, borderRadius: 8, background: '#2b2b2b', color: '#fff' }}>
                <span style={{ width: 28, height: 28, borderRadius: 6, background: '#ff6a00', display: 'grid', placeItems: 'center' }}>🟠</span>
                <span>Solflare</span>
                <span style={{ marginLeft: 'auto', opacity: .6, fontSize: 12 }}>In-app browser</span>
              </button>
              <button onClick={() => { setShowBrowseModal(false); handleOpenInWallet('backpack'); }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, borderRadius: 8, background: '#2b2b2b', color: '#fff' }}>
                <span style={{ width: 28, height: 28, borderRadius: 6, background: '#ffca28', display: 'grid', placeItems: 'center' }}>🎒</span>
                <span>Backpack</span>
                <span style={{ marginLeft: 'auto', opacity: .6, fontSize: 12 }}>In-app browser</span>
              </button>
              <button onClick={() => { setShowBrowseModal(false); handleOpenInWallet('metamask'); }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, borderRadius: 8, background: '#2b2b2b', color: '#fff' }}>
                <span style={{ width: 28, height: 28, borderRadius: 6, background: '#f6851b', display: 'grid', placeItems: 'center' }}>🦊</span>
                <span>MetaMask</span>
                <span style={{ marginLeft: 'auto', opacity: .6, fontSize: 12 }}>In-app browser</span>
              </button>
              <button onClick={() => { setShowBrowseModal(false); handleOpenInWallet('trust'); }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, borderRadius: 8, background: '#2b2b2b', color: '#fff' }}>
                <span style={{ width: 28, height: 28, borderRadius: 6, background: '#2a5ada', display: 'grid', placeItems: 'center' }}>🛡️</span>
                <span>Trust Wallet</span>
                <span style={{ marginLeft: 'auto', opacity: .6, fontSize: 12 }}>In-app browser</span>
              </button>
            </div>
            <div style={{ marginTop: 10, fontSize: 12, opacity: .7 }}>
              * 일부 지갑은 공식 'browse' 딥링크가 없어 QR 또는 URL 복사 방식으로 열립니다.
            </div>
          </div>
        </div>
      )}

      {qr && (
        <div
          onClick={() => setQr(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'grid',
            placeItems: 'center',
            zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: '#fff', padding: 16, borderRadius: 8, textAlign: 'center', width: 360 }}
          >
            <h3 style={{ marginTop: 0 }}>Scan with {qr.wallet}</h3>
            <img
              alt="deeplink QR"
              width={300}
              height={300}
              src={`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr.url)}`}
            />
            <p style={{ wordBreak: 'break-all', fontSize: 12, marginTop: 8 }}>{qr.url}</p>
            <button onClick={() => setQr(null)} style={{ marginTop: 12 }}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}