import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin } from '../../vitest.shared.ts'

// Out-of-tree plugin tests run against the harness SOURCE plane through the
// repository's tsconfig.base.json path facade, exactly like in-tree suites.
// The standard decorator pre-transform is required for harness sources that
// use TS decorators (e.g. TypertRemoteService-based registries).
// `root` pins the plugin directory so include globs and the projects path
// both resolve relative to this package, not the harness checkout root.
export default defineConfig({
  root: 'chajian/dsh-dream-reflection',
  plugins: [tsconfigPaths({ projects: ['../../tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
