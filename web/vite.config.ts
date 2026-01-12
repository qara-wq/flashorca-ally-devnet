import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // .env(.local)와 프로세스 환경에서 로드(프리픽스 제한 없음)
  const env = loadEnv(mode, process.cwd(), '');

  // 새 폴더명으로 바뀌어도 빌드 산출물 위치를 쉽게 바꿀 수 있도록 환경변수 허용
  // 우선순위: BUILD_OUT_DIR > VITE_BUILD_OUT_DIR > 기존 하드코딩 경로
  const configuredOutDir = env.BUILD_OUT_DIR || env.VITE_BUILD_OUT_DIR;
  const defaultOutDir = '/Users/luke/www/flashorca-ally-devnet/static/solana_mwa';
  const outDir = configuredOutDir || (mode === 'production' ? defaultOutDir : `${defaultOutDir}-${mode}`);

  return {
    plugins: [react(), nodePolyfills()],
    optimizeDeps: {
      include: ['buffer', 'bigint-buffer']
    },
    server: {
      host: true,                 // 0.0.0.0 바인딩
      cors: {
        origin: [
          'http://localhost:8000',
          'http://127.0.0.1:8000',
          'http://localhost:9000',
          'http://127.0.0.1:9000',
          'http://localhost:5175',
          'http://127.0.0.1:5175',
          'https://devnet.flashorca.com',
          'https://ally-devnet.flashorca.com',
        ],
        credentials: false,
      },
      allowedHosts: [
        'flashorca.com',
        'devnet.flashorca.com',
        'ally-devnet.flashorca.com',
        'localhost',
        '127.0.0.1',
      ],
      port: 5175, // 프론트
      proxy: {
        // /api/* 요청을 Flask(5050)로 전달
        '/api': {
          target: 'http://localhost:9000',
          changeOrigin: true,
          secure: false,
        },
        // 헬스체크도 필요하면
        '/healthz': {
          target: 'http://localhost:9000',
          changeOrigin: true,
          secure: false,
        },
        '/rpc': { target: 'http://localhost:9000', changeOrigin: true, secure: false },
      },
    },
    headers: { 'Access-Control-Allow-Origin': '*' },
    // ✅ Flask 정적 폴더로 빌드 + 고정 파일명
    build: {
      outDir,
      emptyOutDir: true,
      assetsDir: 'assets',
      sourcemap: false,
      rollupOptions: {
        output: {
          entryFileNames: 'wallet.js',          // 해시 제거 → Jinja에서 고정 경로로 include
          chunkFileNames: 'wallet.[name].js',
          assetFileNames: (info) =>
            (info.name && info.name.endsWith('.css')) ? 'wallet.css' : 'assets/[name][extname]',
        },
      },
    },
  }
})
