import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  test: {
    globalSetup: ['app/test/globalSetup.ts'],
    environment: 'jsdom',
    include: ['app/test/**/*.test.ts?(x)'],
  },
});
