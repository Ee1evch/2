import { defineConfig } from 'vitest/config'
import preact from '@preact/preset-vite'
import { resolve } from 'node:path'

// Три страницы: пульт телефона (/), дашборд ПК (/dashboard/) и витрина UI Kit (/kit/).
// Всё раздаётся ядром DotLink с ПК — без интернета и CDN.
export default defineConfig({
  plugins: [preact()],
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        remote: resolve(__dirname, 'index.html'),
        dashboard: resolve(__dirname, 'dashboard/index.html'),
        kit: resolve(__dirname, 'kit/index.html'),
      },
    },
  },
  worker: { format: 'es' },
  server: { host: true, port: 5173 },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
})
