import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The DB-integration files (tests/integration/*) all point at ONE
    // shared PostgreSQL and wipe shared tables (audit.events,
    // moderation.pending_operations, …) in their beforeEach. Running test
    // FILES in parallel makes them delete each other's fixtures mid-test —
    // observed as flaky "row not found" / short-count failures in CI
    // (MR !11). Unit files are fast, so serializing costs little; the
    // isolation contract of the integration suite demands it.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'cobertura'],
    },
  },
});
