import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // .workflow/ holds the run folders, whose arena worktrees are full copies of the repo
    exclude: ['node_modules/**', 'test/manual/**', '.workflow/**'],
    // Many tests run real git commands; the default 5s fails under parallel load
    testTimeout: 30_000,
  },
});
