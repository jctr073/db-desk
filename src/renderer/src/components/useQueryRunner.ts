import { useCallback, useRef, useState } from 'react'

import type { QueryResult } from '../../../shared/db'
import type { ConnectionType } from '../../../shared/dialect'

/** A (connection, database) pair a query can execute against. */
export interface QueryTarget {
  connId: string
  connName: string
  database: string
  /** True for the database the connection was originally opened against. */
  primary: boolean
  connectionType?: ConnectionType
}

export interface ResultTab {
  id: string
  title: string
  pinned: boolean
  running: boolean
  /** Who initiated the run; 'ai' tabs are grouped under one AI Agent tab. */
  source: 'user' | 'ai' | 'preview'
  /** True on the last AI run of an agent turn — the "final" result. */
  final: boolean
  /** Best-effort main table name, for compact run chips. */
  hint: string
  /** Statement text as sent (before any auto-LIMIT). */
  sql: string
  target: QueryTarget
  result: QueryResult | null
  error: string | null
}

export interface QueryRunner {
  tabs: ResultTab[]
  activeTabId: string | null
  setActiveTab: (id: string | null) => void
  /** Execute into the live (unpinned) tab, creating it if needed. */
  run: (sql: string, target: QueryTarget, limit: number | null) => void
  /** Open (or refresh) a named, pinned relation preview tab. */
  preview: (sql: string, title: string, target: QueryTarget) => void
  /** Re-execute a tab's stored query in place. */
  rerun: (id: string, limit: number | null) => void
  /** Display an already-executed result (e.g. an AI agent run) as a pinned tab. */
  showResult: (
    sql: string,
    target: QueryTarget,
    result: QueryResult | null,
    error: string | null
  ) => void
  /** Mark the most recent AI run as the turn's final result. */
  finalizeAiRun: () => void
  pin: (id: string) => void
  closeTab: (id: string) => void
  /** Close several tabs at once (e.g. "Clear all" on the AI Agent group). */
  closeTabs: (ids: string[]) => void
  closeAll: () => void
}

let tabSeq = 0
let resultSeq = 0

/** Best-effort main table name, used to make tab titles scannable. */
function tableHint(sql: string): string {
  const match = /\bfrom\s+("?[\w.]+"?)/i.exec(sql)
  if (!match) return ''
  const name = match[1].replace(/"/g, '').split('.').pop() ?? ''
  return name.length > 18 ? `${name.slice(0, 18)}…` : name
}

function resultTitle(prefix: string, sql: string): string {
  const hint = tableHint(sql)
  const label = `${prefix} ${++resultSeq}`
  return hint ? `${label} · ${hint}` : label
}

export function useQueryRunner(): QueryRunner {
  const [tabs, setTabs] = useState<ResultTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  /** Per-tab run token; a stale response for a superseded run is dropped. */
  const runTokens = useRef(new Map<string, number>())

  const execute = useCallback(
    async (tabId: string, sql: string, target: QueryTarget, limit: number | null) => {
      const token = (runTokens.current.get(tabId) ?? 0) + 1
      runTokens.current.set(tabId, token)
      const res = await window.dbDesk.db.query(target.connId, target.database, sql, limit)
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
        source: 'user',
        final: false,
        hint: tableHint(sql),
        sql,
        target,
        result: null,
        error: null
      }
      setTabs((prev) => (live ? prev.map((tab) => (tab.id === id ? next : tab)) : [...prev, next]))
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
        prev.map((t) => (t.id === id ? { ...t, running: true, result: null, error: null } : t))
      )
      setActiveTabId(id)
      void execute(id, tab.sql, tab.target, limit)
    },
    [tabs, execute]
  )

  const preview = useCallback(
    (sql: string, title: string, target: QueryTarget) => {
      const existing = tabs.find(
        (tab) =>
          tab.source === 'preview' &&
          tab.sql === sql &&
          tab.target.connId === target.connId &&
          tab.target.database === target.database
      )
      const id = existing?.id ?? `r${++tabSeq}`
      const next: ResultTab = {
        id,
        title,
        pinned: true,
        running: true,
        source: 'preview',
        final: false,
        hint: tableHint(sql),
        sql,
        target,
        result: null,
        error: null
      }
      setTabs((prev) =>
        existing ? prev.map((tab) => (tab.id === id ? next : tab)) : [...prev, next]
      )
      setActiveTabId(id)
      void execute(id, sql, target, 100)
    },
    [tabs, execute]
  )

  const showResult = useCallback(
    (sql: string, target: QueryTarget, result: QueryResult | null, error: string | null) => {
      const id = `r${++tabSeq}`
      const tab: ResultTab = {
        id,
        title: resultTitle('AI Result', sql),
        pinned: true,
        running: false,
        source: 'ai',
        final: false,
        hint: tableHint(sql),
        sql,
        target,
        result,
        error
      }
      setTabs((prev) => [...prev, tab])
      setActiveTabId(id)
    },
    []
  )

  const finalizeAiRun = useCallback(() => {
    setTabs((prev) => {
      const last = [...prev].reverse().find((tab) => tab.source === 'ai')
      if (!last || last.final) return prev
      return prev.map((tab) => (tab.id === last.id ? { ...tab, final: true } : tab))
    })
  }, [])

  const pin = useCallback(
    (id: string) => {
      const tab = tabs.find((t) => t.id === id)
      if (!tab || tab.pinned) return
      // Computed outside the updater: resultSeq++ must run exactly once.
      const title = resultTitle('Result', tab.sql)
      setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, pinned: true, title } : t)))
    },
    [tabs]
  )

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

  const closeTabs = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return
      const closing = new Set(ids)
      for (const id of ids) runTokens.current.delete(id)
      const remaining = tabs.filter((tab) => !closing.has(tab.id))
      setTabs(remaining)
      setActiveTabId((prev) => {
        if (prev === null || !closing.has(prev)) return prev
        return remaining.length > 0 ? remaining[remaining.length - 1].id : null
      })
    },
    [tabs]
  )

  const closeAll = useCallback(() => {
    runTokens.current.clear()
    setTabs([])
    setActiveTabId(null)
  }, [])

  return {
    tabs,
    activeTabId,
    setActiveTab: setActiveTabId,
    run,
    preview,
    rerun,
    showResult,
    finalizeAiRun,
    pin,
    closeTab,
    closeTabs,
    closeAll
  }
}
