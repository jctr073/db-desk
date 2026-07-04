import { useCallback, useRef, useState } from 'react'

import type { QueryResult } from '../../../shared/db'

/** A (connection, database) pair a query can execute against. */
export interface QueryTarget {
  connId: string
  connName: string
  database: string
  /** True for the database the connection was originally opened against. */
  primary: boolean
}

export interface ResultTab {
  id: string
  title: string
  pinned: boolean
  running: boolean
  /** Statement text as sent (before any auto-LIMIT). */
  sql: string
  target: QueryTarget
  result: QueryResult | null
  error: string | null
}

export interface QueryRunner {
  tabs: ResultTab[]
  activeTabId: string | null
  setActiveTab: (id: string) => void
  /** Execute into the live (unpinned) tab, creating it if needed. */
  run: (sql: string, target: QueryTarget, limit: number | null) => void
  /** Re-execute a tab's stored query in place. */
  rerun: (id: string, limit: number | null) => void
  pin: (id: string) => void
  closeTab: (id: string) => void
}

let tabSeq = 0

function snippet(sql: string): string {
  const flat = sql.replace(/\s+/g, ' ').trim()
  return flat.length > 26 ? `${flat.slice(0, 26)}…` : flat
}

export function useQueryRunner(): QueryRunner {
  const [tabs, setTabs] = useState<ResultTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  /** Per-tab run token; a stale response for a superseded run is dropped. */
  const runTokens = useRef(new Map<string, number>())

  const execute = useCallback(
    async (
      tabId: string,
      sql: string,
      target: QueryTarget,
      limit: number | null
    ) => {
      const token = (runTokens.current.get(tabId) ?? 0) + 1
      runTokens.current.set(tabId, token)
      const res = await window.dbDesk.db.query(
        target.connId,
        target.database,
        sql,
        limit
      )
      if (runTokens.current.get(tabId) !== token) return
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                running: false,
                result: res.ok ? res.data : null,
                error: res.ok ? null : res.error
              }
            : tab
        )
      )
    },
    []
  )

  const run = useCallback(
    (sql: string, target: QueryTarget, limit: number | null) => {
      const live = tabs.find((tab) => !tab.pinned)
      const id = live ? live.id : `r${++tabSeq}`
      const next: ResultTab = {
        id,
        title: 'Results',
        pinned: false,
        running: true,
        sql,
        target,
        result: null,
        error: null
      }
      setTabs((prev) =>
        live ? prev.map((tab) => (tab.id === id ? next : tab)) : [...prev, next]
      )
      setActiveTabId(id)
      void execute(id, sql, target, limit)
    },
    [tabs, execute]
  )

  const rerun = useCallback(
    (id: string, limit: number | null) => {
      const tab = tabs.find((t) => t.id === id)
      if (!tab || tab.running) return
      setTabs((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, running: true, result: null, error: null } : t
        )
      )
      setActiveTabId(id)
      void execute(id, tab.sql, tab.target, limit)
    },
    [tabs, execute]
  )

  const pin = useCallback((id: string) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === id && !tab.pinned
          ? { ...tab, pinned: true, title: snippet(tab.sql) }
          : tab
      )
    )
  }, [])

  const closeTab = useCallback(
    (id: string) => {
      runTokens.current.delete(id)
      const remaining = tabs.filter((tab) => tab.id !== id)
      setTabs(remaining)
      setActiveTabId((prev) => {
        if (prev !== id) return prev
        if (remaining.length === 0) return null
        const closedIndex = tabs.findIndex((tab) => tab.id === id)
        return remaining[Math.min(closedIndex, remaining.length - 1)].id
      })
    },
    [tabs]
  )

  return {
    tabs,
    activeTabId,
    setActiveTab: setActiveTabId,
    run,
    rerun,
    pin,
    closeTab
  }
}
