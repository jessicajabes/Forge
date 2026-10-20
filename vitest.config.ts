import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['node_modules/**', 'test/manual/**'],
    // Many tests run real git commands; the default 5s fails under parallel load
    testTimeout: 30_000,
  },
});
