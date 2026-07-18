import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Write JSON to `path` via tmp-file + rename, so a crash mid-write can never
 * leave a truncated file behind — for stores like connections.json, a torn
 * write would otherwise read back as "corrupt" and be silently replaced by
 * an empty store on the next save. Same tmp+rename discipline knowledge.ts
 * and skills.ts already follow, shared so every store uses it.
 *
 * `mode` (e.g. 0o600 for files holding secrets) is applied to the tmp file
 * before the rename; rename preserves it, so the final file always carries
 * it regardless of whether it existed before.
 */
export function writeJsonAtomic(
  path: string,
  data: unknown,
  options: { mode?: number; pretty?: boolean } = {}
): void {
  const { mode, pretty = true } = options
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  const text = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', mode })
    if (mode !== undefined) {
      try {
        // writeFileSync's mode is masked by umask and skipped when the tmp
        // file already exists; chmod makes the requested mode authoritative.
        chmodSync(tmp, mode)
      } catch {
        // best effort (e.g. filesystems without POSIX permissions)
      }
    }
    renameSync(tmp, path)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // A leftover tmp file is harmless; the real file was never touched.
    }
    throw error
  }
}
