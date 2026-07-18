import { useCallback, useEffect, useState } from 'react'

import type { Skill, SkillSaveInput } from '../../../shared/skills'

export interface SkillsState {
  /** All resolved skills (built-ins merged with overrides, plus customs). */
  skills: Skill[]
  loading: boolean
  error: string | null

  save: (input: SkillSaveInput) => Promise<Skill | null>
  /** Deletes a custom skill; for a built-in id, resets it to installed. */
  remove: (id: string) => Promise<boolean>
  clearError: () => void
}

/**
 * The skills list, kept live: loaded over the preload bridge, then reloaded
 * on every skills:changed push — so edits, resets, and the cascade delete
 * that follows a removed connection all refresh the panel without UI action.
 * Follows the useKnowledgeState house pattern.
 */
export function useSkillsState(): SkillsState {
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const loaded = await window.dbDesk.skills.list()
        if (!cancelled) setSkills(loaded)
      } catch (err) {
        if (!cancelled) {
          setError(`Failed to load skills: ${err instanceof Error ? err.message : String(err)}`)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    const unsubscribe = window.dbDesk.skills.onChanged(() => void load())
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const save = useCallback(async (input: SkillSaveInput): Promise<Skill | null> => {
    try {
      const saved = await window.dbDesk.skills.save(input)
      // The change push reloads too; upsert now so the UI doesn't wait.
      setSkills((prev) =>
        prev.some((s) => s.id === saved.id)
          ? prev.map((s) => (s.id === saved.id ? saved : s))
          : [...prev, saved]
      )
      return saved
    } catch (err) {
      setError(`Failed to save skill: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }, [])

  const remove = useCallback(async (id: string): Promise<boolean> => {
    try {
      await window.dbDesk.skills.remove(id)
      // Built-ins never leave the list — the change push restores the
      // installed version; only optimistically drop custom skills.
      setSkills((prev) => prev.filter((s) => s.id !== id || s.builtin))
      return true
    } catch (err) {
      setError(`Failed to delete skill: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }, [])

  const clearError = useCallback(() => setError(null), [])

  return { skills, loading, error, save, remove, clearError }
}
