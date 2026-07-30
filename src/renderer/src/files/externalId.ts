/**
 * External (watched-folder) files share the editor's per-file buffer map and
 * dirty tracking with internal query files. Internal ids are opaque UUIDs, so
 * a prefixed absolute path can never collide with one.
 */

const EXTERNAL_ID_PREFIX = 'ext:'

export function externalBufferId(path: string): string {
  return `${EXTERNAL_ID_PREFIX}${path}`
}

export function isExternalBufferId(id: string): boolean {
  return id.startsWith(EXTERNAL_ID_PREFIX)
}

export function externalPathFromId(id: string): string {
  return id.slice(EXTERNAL_ID_PREFIX.length)
}

/** Display name of an external file (base name of its absolute path). */
export function externalFileName(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return name || path
}
