import { defineConfig } from 'vitest/config'

// Two projects so `npm run test:unit` stays fast and Docker-free while the
// integration project owns the global setup that brings up the test database.
// `npm test` runs both.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts', 'src/**/*.test.ts'],
          environment: 'node'
        }
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['test/integration/support/globalSetup.ts'],
          // Integration tests share one database; run their files serially so
          // one file's reseed cannot clobber another's rows mid-assertion.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000
        }
      }
    ]
  }
})
