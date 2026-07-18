import { describe, expect, it } from 'vitest'

import type { QueryFile } from './useFileState'
import { closeOpenFiles } from './useFileState'

const files: QueryFile[] = ['one', 'two', 'three'].map((id, index) => ({
  id,
  name: `${id}.sql`,
  connId: 'connection',
  database: 'database',
  createdAt: index,
  updatedAt: index
}))

describe('closeOpenFiles', () => {
  it('closes every requested file and selects the first remaining open file', () => {
    const next = closeOpenFiles(files, new Set(['one', 'two', 'three']), 'two', ['one', 'two'])

    expect([...next.openFileIds]).toEqual(['three'])
    expect(next.selectedFileId).toBe('three')
  })

  it('preserves the selection when closing a different group', () => {
    const next = closeOpenFiles(files, new Set(['one', 'two', 'three']), 'one', ['two', 'three'])

    expect([...next.openFileIds]).toEqual(['one'])
    expect(next.selectedFileId).toBe('one')
  })

  it('clears the selection when no open files remain', () => {
    const next = closeOpenFiles(files, new Set(['one']), 'one', ['one'])

    expect(next.openFileIds.size).toBe(0)
    expect(next.selectedFileId).toBeNull()
  })
})
