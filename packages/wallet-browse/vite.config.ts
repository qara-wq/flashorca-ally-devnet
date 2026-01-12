import { defineConfig } from 'vite'
import * as fs from 'fs'
import * as path from 'path'

function copyToNexus() {
  const targetDir = '/Users/luke/www/NexusAI/static/js'
  const targetFile = 'wallet-browse.umd.js'
  return {
    name: 'copy-wallet-browse-umd-to-nexus',
    apply: 'build',
    async writeBundle(options: any, bundle: Record<string, any>) {
      try {
        await fs.promises.mkdir(targetDir, { recursive: true })
        const dst = path.join(targetDir, targetFile)
        const umdChunk = bundle[targetFile]
        if (!umdChunk || typeof umdChunk.code !== 'string') {
          // Only act when UMD output is available to avoid noisy errors during ES write
          return
        }
        await fs.promises.writeFile(dst, umdChunk.code, 'utf8')
        const map = bundle[targetFile + '.map']
        if (map && typeof map.source === 'string') {
          await fs.promises.writeFile(dst + '.map', map.source, 'utf8')
        }
        // eslint-disable-next-line no-console
        console.log(`Wrote ${dst} from bundle`)
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[wallet-browse] post-build copy failed:', e)
      }
    },
  }
}

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'FlashOrcaBrowse',
      fileName: (format) => format === 'es' ? 'wallet-browse.js' : 'wallet-browse.umd.js',
      formats: ['es', 'umd'],
    },
    sourcemap: true,
    rollupOptions: {
      external: [],
    },
    outDir: 'dist',
    emptyOutDir: true,
  },
  plugins: [copyToNexus()],
});
