import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['src/utils.js'],
      reporter: ['text', 'html', 'lcov'],
    },
  },
});
