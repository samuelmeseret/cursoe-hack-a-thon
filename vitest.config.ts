import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false,
    env: { ARTIFACT_DIR: resolve('.artifacts/tests/controller-runs') },
  },
});
