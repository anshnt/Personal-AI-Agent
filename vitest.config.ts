import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Native tsconfig path resolution, so `@/` works without a plugin.
  resolve: { tsconfigPaths: true },
  test: {
    // Unit tests only: everything here runs with no database and no network, so
    // `npm test` gives fast feedback. The database-backed integration checks
    // live in scripts/smoke-*.ts and run under `npm run smoke`.
    include: ['src/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
  },
});
