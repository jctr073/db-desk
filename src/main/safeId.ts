/**
 * Guard for renderer-supplied ids that become filesystem path segments.
 *
 * Ids arrive over IPC and are joined into paths under userData (knowledge
 * bases, query files, the schema cache), so they must never be able to
 * escape their directory — `deleteQuery('../..')` would otherwise unlink
 * outside the store. House ids are `<prefix>-<ts>-<rand>`; anything outside
 * that alphabet fails closed, same trust model as the renderer-tampering
 * guards in agent.ts.
 */
export function assertSafeId(id: string, what: string): void {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid ${what} id: ${JSON.stringify(id)}`)
  }
}
