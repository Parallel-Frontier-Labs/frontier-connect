import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: {
    globalSetup: ['app/test/globalSetup.ts'],
    environment: 'jsdom',
    include: ['app/test/**/*.test.ts?(x)'],
  },
});
