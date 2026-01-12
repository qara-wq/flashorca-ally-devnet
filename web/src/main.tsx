import { Buffer } from 'buffer';
;(globalThis as any).Buffer = Buffer;
(window as any).Buffer = Buffer;

import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import '@solana/wallet-adapter-react-ui/styles.css';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';

import {
  registerMwa,
  createDefaultAuthorizationCache,
  createDefaultChainSelector,
  createDefaultWalletNotFoundHandler,
} from '@solana-mobile/wallet-standard-mobile';

const rawRpc = (import.meta.env.VITE_SOLANA_RPC ?? '').trim();
const endpoint =
  rawRpc.startsWith('http://') || rawRpc.startsWith('https://')
    ? rawRpc
    : `${window.location.origin}${rawRpc || '/rpc'}`;
const remoteHost = import.meta.env.VITE_MWA_REMOTE_HOST; // QR 원격 연결을 원하면 세팅
const appOrigin = (import.meta.env.VITE_APP_ORIGIN ?? window.location.origin).toString().replace(/\/+$/, '');
const appIcon = `${appOrigin}/static/flashorca_assets/images/favicon.ico`;
const appName = (import.meta.env.VITE_APP_NAME ?? 'FlashOrca Ally Devnet').toString();

// SSR이 아닌 곳에서만 호출
registerMwa({
  appIdentity: {
    name: appName,
    uri: appOrigin,
    icon: appIcon,
  },
  authorizationCache: createDefaultAuthorizationCache(),
  chains: ['solana:mainnet', 'solana:devnet'],
  chainSelector: createDefaultChainSelector(),
  onWalletNotFound: createDefaultWalletNotFoundHandler(),
  // 데스크톱에서 QR 원격 연결을 활성화
  remoteHostAuthority: remoteHost, // 없으면 모바일 로컬 연결만 등록됨
});



// ReactDOM.createRoot(document.getElementById('root')!).render(
//   <>
//     <ConnectionProvider endpoint={endpoint}>
//       <WalletProvider wallets={[]} autoConnect>
//         <WalletModalProvider>
//           <App />
//         </WalletModalProvider>
//       </WalletProvider>
//     </ConnectionProvider>
//   </>
// );

// ② autoConnect 를 다음 틱에 켜는 루트 컴포넌트
function Root() {
  const [deferredAutoConnect, setDeferredAutoConnect] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setDeferredAutoConnect(true), 0);
    return () => clearTimeout(id);
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider
        wallets={[]}
        autoConnect={deferredAutoConnect}
        onError={(e) => console.warn('[wallet-adapter error]', e)}
        localStorageKey="forca_wallet"
      >
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

const mountEl = document.querySelector<HTMLElement>('[data-mwa-mount], #reward_claim, #root');
if (mountEl) {
  ReactDOM.createRoot(mountEl).render(<Root />);
}
