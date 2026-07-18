import { describe, expect, it } from 'vitest'

import { selectGridHeaders } from './resultGridSelection'

const plain = { metaKey: false, ctrlKey: false, shiftKey: false }
const command = { metaKey: true, ctrlKey: false, shiftKey: false }
const shift = { metaKey: false, ctrlKey: false, shiftKey: true }
const commandShift = { metaKey: true, ctrlKey: false, shiftKey: true }

describe('selectGridHeaders', () => {
  it('replaces the selection on a plain click', () => {
    expect([...selectGridHeaders(new Set([0, 2]), 4, 2, plain)]).toEqual([4])
  })

  it('clears a sole selection when its header is clicked again', () => {
    expect([...selectGridHeaders(new Set([4]), 4, 4, plain)]).toEqual([])
  })

  it('keeps a clicked header when it is part of a larger selection', () => {
    expect([...selectGridHeaders(new Set([2, 4]), 4, 2, plain)]).toEqual([4])
  })

  it('toggles one header on a Command-click', () => {
    expect([...selectGridHeaders(new Set([0, 2]), 4, 2, command)]).toEqual([0, 2, 4])
    expect([...selectGridHeaders(new Set([0, 2]), 2, 0, command)]).toEqual([0])
  })

  it('replaces the selection with the anchor range on a Shift-click', () => {
    expect([...selectGridHeaders(new Set([0, 6]), 4, 1, shift)]).toEqual([1, 2, 3, 4])
  })

  it('adds an anchor range on a Command-Shift-click', () => {
    expect([...selectGridHeaders(new Set([0, 6]), 4, 2, commandShift)]).toEqual([0, 6, 2, 3, 4])
  })

  it('uses the clicked header as the range when there is no anchor', () => {
    expect([...selectGridHeaders(new Set([0]), 4, null, shift)]).toEqual([4])
  })
})
