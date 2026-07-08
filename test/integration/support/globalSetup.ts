/**
 * Brings up the test database before the integration suite runs.
 *
 * `docker compose up -d --wait` blocks on the container healthcheck, which
 * (because it forces TCP) only passes once the seed scripts have finished.
 * We still poll for a seeded row as a belt: a half-initialised database
 * would otherwise produce baffling test failures.
 *
 * Env:
 *   DBDESK_TEST_NO_DOCKER=1     assume a server is already listening
 *   DBDESK_TEST_DOCKER_DOWN=1   tear the container down afterwards
 */

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { clientConfig, PG_HOST, PG_PORT } from './config'

const COMPOSE_FILE = fileURLToPath(
  new URL('../../docker-compose.yml', import.meta.url)
)

function compose(...args: string[]): void {
  execFileSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    stdio: 'inherit'
  })
}

async function waitForSeed(attempts = 30): Promise<void> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    const client = new Client(clientConfig())
    try {
      await client.connect()
      await client.query('SELECT count(*) FROM customers')
      await client.end()
      return
    } catch (err) {
      lastError = err
      await client.end().catch(() => {})
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error(
    `Test database at ${PG_HOST}:${PG_PORT} never became ready: ${String(lastError)}`
  )
}

export async function setup(): Promise<void> {
  if (process.env.DBDESK_TEST_NO_DOCKER !== '1') {
    compose('up', '-d', '--wait')
  }
  await waitForSeed()
}

export async function teardown(): Promise<void> {
  if (process.env.DBDESK_TEST_DOCKER_DOWN === '1') {
    compose('down', '-v')
  }
}
