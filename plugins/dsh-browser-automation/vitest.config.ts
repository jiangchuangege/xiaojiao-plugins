import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      // types.ts is types-only by convention (no runtime statements) and is
      // excluded; extract.ts's page-side extractor is marked `/* v8 ignore */`
      // because it executes inside the browser process — its behavior is
      // covered by the real-Chrome integration suite instead.
      exclude: ['**/types.ts'],
      // Per-file 100% is the release gate (plan §12.2).
      thresholds: {
        perFile: true,
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
