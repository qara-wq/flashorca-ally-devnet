export type BrowseWallet =
  | 'phantom' | 'solflare' | 'backpack'
  | 'metamask' | 'trust' | 'bitget' | 'exodus';

// very light UA check; adequate for deciding QR vs redirect
export function detectEnvironment() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const ref = typeof document !== 'undefined' ? (document.referrer || '') : '';
  const isMobile = /iPhone|iPad|iPod|Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const inAppWalletUA = /(Phantom|Solflare|Backpack|MetaMask|MetaMaskMobile|TrustWallet|Trust|Bitget|Exodus)/i.test(ua)
    || /metamask\.app\.link|trustwallet|bitget|exodus/i.test(ref);
  const hasInjectedProvider = !!(typeof window !== 'undefined' && (
    (window as any).solana && (((window as any).solana.isPhantom) || ((window as any).solana.isSolflare) || ((window as any).solana.isBackpack))
  ));
  const isSafari = /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS/i.test(ua);
  return { isMobile, isIOS, isSafari, inAppWalletUA, hasInjectedProvider };
}

const TRUSTWALLET_COIN_ID = '501'; // Solana SLIP-0044

const toMetaMaskDappPath = (absUrl: string) => {
  const u = new URL(absUrl);
  return `${u.host}${u.pathname}${u.search}${u.hash}`;
};

export function buildBrowseLink(wallet: BrowseWallet, url: string, ref: string) {
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
      return `https://link.trustwallet.com/open_url?coin_id=${encodeURIComponent(TRUSTWALLET_COIN_ID)}&url=${encodeURIComponent(url)}`;
    case 'bitget':
    case 'exodus':
      return url; // no stable public browse deep link → use QR/copy fallback
    default:
      throw new Error('unknown wallet');
  }
}

export function getTargetAndRefFromLocation(): { targetUrl: string; refUrl: string } {
  const loc = typeof window !== 'undefined' ? window.location : { href: '', origin: '' } as any;
  const targetUrl = String(loc.href || '').toString();
  const refUrl = (typeof import.meta !== 'undefined' && (import.meta as any)?.env?.VITE_APP_REF)
    ? String((import.meta as any).env.VITE_APP_REF)
    : String(loc.origin || '');
  return { targetUrl, refUrl };
}

export type OpenInWalletOptions = {
  preferQrOnDesktop?: boolean;
  onQr?: (deeplink: string) => void; // called if desktop & preferQrOnDesktop
  ref?: string; // override ref URL
  targetUrl?: string; // override target URL
};

export function openInWallet(wallet: BrowseWallet, opts: OpenInWalletOptions = {}) {
  const env = detectEnvironment();
  const { targetUrl: defTarget, refUrl: defRef } = getTargetAndRefFromLocation();
  const targetUrl = opts.targetUrl || defTarget;
  const refUrl = opts.ref || defRef;
  const deeplink = buildBrowseLink(wallet, targetUrl, refUrl);

  const preferQr = opts.preferQrOnDesktop ?? true;
  if (!env.isMobile && preferQr && typeof opts.onQr === 'function') {
    opts.onQr(deeplink);
    return;
  }
  if (env.isMobile) {
    window.location.href = deeplink;
  } else if (typeof opts.onQr === 'function') {
    opts.onQr(deeplink);
  } else {
    // fallback: open a new tab with the deeplink (some desktop wallets may intercept)
    window.open(deeplink, '_blank');
  }
}

// Simple helper to produce a QR image URL via a public endpoint (no dependency)
export function buildQrImageUrl(data: string, size = 300): string {
  const s = Math.max(100, Math.min(1024, size|0));
  return `https://api.qrserver.com/v1/create-qr-code/?size=${s}x${s}&data=${encodeURIComponent(data)}`;
}

// ----------------------------
// Minimal UI Overlay (no deps)
// ----------------------------

type OverlayOptions = {
  wallets?: BrowseWallet[];
  preferQrOnDesktop?: boolean;
  targetUrl?: string;
  ref?: string;
  onClose?: () => void;
};

const DEFAULT_WALLETS: BrowseWallet[] = ['phantom', 'solflare', 'backpack', 'metamask', 'trust'];

function injectOverlayStylesOnce() {
  if (typeof document === 'undefined') return;
  const id = 'fob-overlay-styles';
  if (document.getElementById(id)) return;
  const css = `
  .fob-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:9999;padding:8px}
  .fob-overlay{background:#10131a;color:#fff;padding:18px;border-radius:16px;width:min(92vw,420px);max-width:100vw;max-height:min(92svh,640px);overflow:auto;box-shadow:0 14px 40px rgba(0,0,0,.45);border:1px solid rgba(202,232,249,0.18)}
  .fob-row{display:flex;gap:10px;align-items:center;padding:10px;border-radius:8px;background:#2b2b2b;color:#fff;cursor:pointer}
  .fob-row:hover{background:#333}
  .fob-icon{width:28px;height:28px;border-radius:6px;display:grid;place-items:center}
  .fob-right{margin-left:auto;opacity:.6;font-size:12px}
  .fob-close{background:transparent;color:#aaa;font-size:18px;padding:8px;line-height:1;border:0;cursor:pointer}
  .fob-qr{width:min(80vw,300px);height:auto}
  .fob-mono{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;}
  `;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
}

function walletVisual(wallet: BrowseWallet): { label: string; bg: string; emoji: string } {
  switch (wallet) {
    case 'phantom': return { label: 'Phantom', bg: '#7c4dff', emoji: '🟣' };
    case 'solflare': return { label: 'Solflare', bg: '#ff6a00', emoji: '🟠' };
    case 'backpack': return { label: 'Backpack', bg: '#ffca28', emoji: '🎒' };
    case 'metamask': return { label: 'MetaMask', bg: '#f6851b', emoji: '🦊' };
    case 'trust': return { label: 'Trust Wallet', bg: '#2a5ada', emoji: '🛡️' };
    case 'bitget': return { label: 'Bitget', bg: '#0b84fe', emoji: '🅱️' };
    case 'exodus': return { label: 'Exodus', bg: '#2b2b2b', emoji: '❖' };
    default: return { label: wallet, bg: '#2b2b2b', emoji: '🟩' };
  }
}

function ensureOverlayRoot() {
  if (typeof document === 'undefined') return null as any;
  injectOverlayStylesOnce();
  let root = document.getElementById('fob-wallet-overlay') as HTMLDivElement | null;
  if (!root) {
    root = document.createElement('div');
    root.id = 'fob-wallet-overlay';
    root.className = 'fob-backdrop';
    root.innerHTML = `
      <div class="fob-overlay fob-mono" onclick="event.stopPropagation()">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <h3 style="margin:0;font-size:18px">Open in Wallet</h3>
          <button class="fob-close" type="button" data-close>✕</button>
        </div>
        <div style="margin-top:12px;display:grid;gap:8px" data-list></div>
        <div style="display:none;margin-top:12px;text-align:center" data-qr>
          <img class="fob-qr" alt="deeplink QR" />
          <p class="fob-mono" style="word-break:break-all;font-size:12px;margin-top:8px" data-url></p>
          <div style="margin-top:8px">Scan with your mobile wallet</div>
        </div>
      </div>`;
    document.body.appendChild(root);
  }
  return root;
}

function fillWalletList(listEl: HTMLElement, wallets: BrowseWallet[]) {
  listEl.innerHTML = wallets.map((w) => {
    const v = walletVisual(w);
    return (
      `<div class="fob-row" data-wallet="${w}"><span class="fob-icon" style="background:${v.bg}">${v.emoji}</span><span>${v.label}</span><span class="fob-right">In-app browser</span></div>`
    );
  }).join('');
}

export function showOpenInWalletOverlay(options: OverlayOptions = {}) {
  const root = ensureOverlayRoot();
  if (!root) return;
  const list = root.querySelector('[data-list]') as HTMLElement;
  const qrBox = root.querySelector('[data-qr]') as HTMLElement;
  const qrImg = root.querySelector('img.fob-qr') as HTMLImageElement;
  const urlEl = root.querySelector('[data-url]') as HTMLElement;
  const closeBtn = root.querySelector('[data-close]') as HTMLElement;

  // Populate wallets
  const wallets = options.wallets && options.wallets.length > 0 ? options.wallets : DEFAULT_WALLETS;
  fillWalletList(list, wallets);

  // Reset QR area
  if (qrBox) qrBox.style.display = 'none';
  if (qrImg) qrImg.removeAttribute('src');
  if (urlEl) urlEl.textContent = '';

  // Close handlers
  const hide = () => {
    (root as HTMLDivElement).style.display = 'none';
    if (typeof options.onClose === 'function') {
      try { options.onClose(); } catch { /* noop */ }
    }
  };
  root.onclick = hide;
  if (closeBtn) closeBtn.onclick = (ev) => { ev.stopPropagation(); hide(); };

  // List click handler
  list.onclick = (ev: any) => {
    ev.stopPropagation();
    let t = ev.target as HTMLElement | null;
    while (t && t !== list && !(t.getAttribute && t.getAttribute('data-wallet'))) t = t.parentElement;
    if (!t) return;
    const wallet = t.getAttribute('data-wallet') as BrowseWallet | null;
    if (!wallet) return;
    openInWallet(wallet, {
      preferQrOnDesktop: options.preferQrOnDesktop ?? true,
      targetUrl: options.targetUrl,
      ref: options.ref,
      onQr: (deeplink: string) => {
        if (qrBox) qrBox.style.display = 'block';
        if (qrImg) qrImg.src = buildQrImageUrl(deeplink, 300);
        if (urlEl) urlEl.textContent = deeplink;
      },
    });
  };

  // Show
  (root as HTMLDivElement).style.display = 'flex';
}

export function attachOpenInWallet(target: string | Element, options: OverlayOptions = {}) {
  if (typeof document === 'undefined') return;
  const el: Element | null = typeof target === 'string' ? document.querySelector(target) : (target as Element);
  if (!el) return;
  const handler = (e: Event) => { e.preventDefault(); showOpenInWalletOverlay(options); };
  el.addEventListener('click', handler);
}
