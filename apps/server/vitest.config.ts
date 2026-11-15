import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@pialy/server',
    globalSetup: ['./test/global-setup.ts'],
    // All files share one Postgres database.
    fileParallelism: false,
    env: { NODE_ENV: 'test' },
  },
});
