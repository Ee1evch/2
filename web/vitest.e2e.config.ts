import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', include: ['test/e2e/**/*.e2e.ts'], testTimeout: 30_000, hookTimeout: 60_000, fileParallelism: false },
})
