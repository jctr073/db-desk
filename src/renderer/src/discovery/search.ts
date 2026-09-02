/**
 * Pure fuzzy-ish search/scoring for the command palette and Discover browser.
 * No React, no DOM, no imports — takes any list of `Searchable` items
 * (features, or anything shaped like one) and ranks them against a query.
 */

export interface Searchable {
  id: string
  title: string
  description: string
  keywords?: string[]
  category: string
}

/** Higher wins. 0 means "no match" and the item is dropped. */
export function scoreMatch(query: string, item: Searchable): number {
  const q = query.trim().toLowerCase()
  if (!q) return 0

  const title = item.title.toLowerCase()
  const description = item.description.toLowerCase()
  const keywords = item.keywords ?? []

  let best = 0

  if (title.startsWith(q)) best = Math.max(best, 100)

  const titleWords = title.split(/\s+/)
  if (titleWords.some((word) => word.startsWith(q))) best = Math.max(best, 80)

  if (title.includes(q)) best = Math.max(best, 60)

  if (keywords.some((k) => k.toLowerCase().startsWith(q))) best = Math.max(best, 50)

  if (description.includes(q)) best = Math.max(best, 30)

  if (isSubsequence(q, title)) best = Math.max(best, 10)

  return best
}

/** True if every character of `needle` appears in `haystack`, in order. */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++
  }
  return i === needle.length
}

/**
 * Ranks `items` against `query`. Empty/whitespace query returns items in
 * their input order (respecting `limit`). Otherwise items with a score of 0
 * are dropped, and the rest are sorted by score descending; ties keep their
 * relative input order (stable sort).
 */
export function searchFeatures<T extends Searchable>(
  query: string,
  items: readonly T[],
  limit?: number
): T[] {
  const q = query.trim()

  if (!q) {
    return limit === undefined ? [...items] : items.slice(0, limit)
  }

  const scored = items
    .map((item, index) => ({ item, index, score: scoreMatch(q, item) }))
    .filter((entry) => entry.score > 0)

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.index - b.index
  })

  const ranked = scored.map((entry) => entry.item)
  return limit === undefined ? ranked : ranked.slice(0, limit)
}
