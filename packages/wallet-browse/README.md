FlashOrca Wallet Browse
=======================

지갑 인앱 브라우저(Phantom, Solflare, Backpack, MetaMask, Trust 등)에서 현재 페이지를 여는 딥링크를 생성하고, 모바일/데스크톱 환경에 맞춰 열기 또는 QR 표시를 도와주는 유틸리티입니다.

설치 (모노레포 내부)
- web 등 워크스페이스에서 `"@flashorca/wallet-browse": "file:../../packages/wallet-browse"` 로 의존성 추가 후 사용.

주요 API
- `buildBrowseLink(wallet, url, ref)` — 지정 지갑용 딥링크 문자열 생성
- `detectEnvironment()` — 간단한 UA 기반 환경 감지
- `openInWallet(wallet, { onQr, preferQrOnDesktop, targetUrl, ref })` — 모바일이면 바로 열고, 데스크톱이면 QR 콜백으로 전달
- `buildQrImageUrl(data, size)` — 외부 QR 이미지 URL(무의존) 생성
- UI 포함 고수준 API (중복 UI 제거용)
  - `showOpenInWalletOverlay(opts?)` — 공통 모달(지갑 목록 + QR) 표시
  - `attachOpenInWallet(target, opts?)` — 버튼/링크에 클릭 핸들러 바인딩하여 모달 표시

HTML에서 바로 사용하기 (UMD)
1) 패키지 디렉터리에서 `npm run build`로 `dist/wallet-browse.umd.js`를 생성합니다.
2) 정적 경로에 배포 후 다음처럼 사용합니다:

<script src="/static/js/wallet-browse.umd.js"></script>
<script>
  const env = FlashOrcaBrowse.detectEnvironment();
  const { targetUrl, refUrl } = FlashOrcaBrowse.getTargetAndRefFromLocation();
  const deeplink = FlashOrcaBrowse.buildBrowseLink('phantom', targetUrl, refUrl);
  if (env.isMobile) {
    location.href = deeplink;
  } else {
    const img = document.getElementById('wallet_qr');
    img.src = FlashOrcaBrowse.buildQrImageUrl(deeplink, 300);
  }
</script>

공통 모달 UI 사용 예시 (UMD)

<script src="/static/js/wallet-browse.umd.js"></script>
<script>
  // 링크/버튼에 공통 UI 바인딩
  FlashOrcaBrowse.attachOpenInWallet('#open-reward-wallet-link');
  // 혹은 즉시 열기
  // FlashOrcaBrowse.showOpenInWalletOverlay();
</script>
