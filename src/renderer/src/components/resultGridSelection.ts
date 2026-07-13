export interface GridSelectionModifiers {
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}

export function selectGridHeaders(
  selected: ReadonlySet<number>,
  index: number,
  anchor: number | null,
  modifiers: GridSelectionModifiers
): Set<number> {
  const additive = modifiers.metaKey || modifiers.ctrlKey

  if (modifiers.shiftKey) {
    const next = additive ? new Set(selected) : new Set<number>()
    const rangeStart = Math.min(anchor ?? index, index)
    const rangeEnd = Math.max(anchor ?? index, index)
    for (let current = rangeStart; current <= rangeEnd; current += 1) {
      next.add(current)
    }
    return next
  }

  if (additive) {
    const next = new Set(selected)
    if (next.has(index)) next.delete(index)
    else next.add(index)
    return next
  }

  if (selected.size === 1 && selected.has(index)) return new Set()

  return new Set([index])
}
