import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeJsonAtomic } from '../../src/main/atomicJson'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'db-desk-atomic-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('writeJsonAtomic', () => {
  it('writes pretty JSON and creates missing parent directories', () => {
    const path = join(dir, 'nested', 'deeper', 'store.json')

    writeJsonAtomic(path, { a: 1 })

    expect(readFileSync(path, 'utf8')).toBe(JSON.stringify({ a: 1 }, null, 2))
  })

  it('writes compact JSON when pretty is false', () => {
    const path = join(dir, 'store.json')

    writeJsonAtomic(path, { a: 1 }, { pretty: false })

    expect(readFileSync(path, 'utf8')).toBe('{"a":1}')
  })

  it('replaces an existing file and leaves no tmp file behind', () => {
    const path = join(dir, 'store.json')
    writeJsonAtomic(path, { version: 1 })

    writeJsonAtomic(path, { version: 2 })

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 2 })
    expect(readdirSync(dir)).toEqual(['store.json'])
  })

  it('applies the requested mode to new and pre-existing files', () => {
    const path = join(dir, 'secrets.json')
    writeJsonAtomic(path, { secret: true })
    // First write took the default mode; the rewrite must tighten it.
    writeJsonAtomic(path, { secret: true }, { mode: 0o600 })

    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('cleans up the tmp file and rethrows when the rename fails', () => {
    // A directory at the target path makes renameSync fail after the tmp
    // file was written — the failure path must not leave the tmp behind.
    const path = join(dir, 'store.json')
    mkdirSync(path)

    expect(() => writeJsonAtomic(path, { a: 1 })).toThrow()

    expect(existsSync(`${path}.tmp`)).toBe(false)
  })
})
