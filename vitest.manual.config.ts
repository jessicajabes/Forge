import { defineConfig } from 'vitest/config';

// Manual tests call the real `claude` and `copilot` CLIs: they need both installed and
// logged in, and they spend plan quota. Run with `npm run test:manual`.
export default defineConfig({
  test: { include: ['test/manual/**/*.manual.ts'], testTimeout: 300_000 },
});
