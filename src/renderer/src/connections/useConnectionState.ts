import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { parseConnectionUrl } from '../../../shared/connectionUrl'
import type {
  ConnectParams,
  DatabaseIntrospection,
  SavedConnection
} from '../../../shared/db'
import { dialectFor } from '../../../shared/dialect'
import type { ConnectionType } from '../../../shared/dialect'
import {
  assignIds,
  connectionNodeFromResult,
  databaseChildren,
  defaultExpansion,
  defaultForm,
  findNode,
  formFromSaved,
  savedConnectionNode
} from './treeData'
import type { ConnectionForm, TreeMode, TreeNode } from './types'

export type TestState = 'idle' | 'testing' | 'ok' | 'error'
export type DialogTab = 'params' | 'url'

export interface ConnectionState {
  tree: TreeNode[]
  expanded: Record<string, boolean>
  selected: string | null
  mode: TreeMode
  filter: string
  selectedNode: TreeNode | null
  canRemove: boolean
  loadError: string | null

  /** Raw introspection per connection id, then per database name. */
  schemas: Record<string, Record<string, DatabaseIntrospection>>
  /** Introspect and cache a database if it isn't cached already. */
  ensureSchema: (connId: string, database: string) => void

  dialogOpen: boolean
  dialogTab: DialogTab
  showPwd: boolean
  testState: TestState
  testMsg: string
  connecting: boolean
  form: ConnectionForm
  /** Set when the dialog is reconnecting an existing saved connection. */
  editingId: string | null

  setMode: (mode: TreeMode) => void
  setFilter: (value: string) => void
  toggleRow: (id: string, expandable: boolean) => void
  collapseAll: () => void
  removeSelected: () => void
  clearLoadError: () => void
  /** Expand the given ancestor row ids and select a node. */
  reveal: (expandIds: string[], selectId: string) => void

  connectSaved: (id: string) => void
  disconnectConnection: (id: string) => void
  removeConnection: (id: string) => void
  /** Re-introspect every loaded database of an online connection. */
  refreshConnection: (id: string) => void

  openDialog: () => void
  closeDialog: () => void
  setDialogTab: (tab: DialogTab) => void
  /** Switch the engine of the connection being created; resets form defaults. */
  setDialogType: (type: ConnectionType) => void
  togglePwd: () => void
  toggleSavePwd: () => void
  updateForm: (key: keyof ConnectionForm, value: string) => void
  testConnection: () => void
  connect: () => void
}

let nextConnectionSeq = 0

function toParams(form: ConnectionForm, useUrl: boolean): ConnectParams {
  return {
    type: form.type,
    host: form.host,
    port: form.port,
    database: form.database,
    user: form.user,
    password: form.password,
    httpPath: form.httpPath,
    url: form.url,
    useUrl: useUrl && dialectFor(form.type).supportsUrl
  }
}

/** Return a new tree with the node at `id` replaced, sharing untouched branches. */
function updateNode(
  nodes: TreeNode[],
  id: string,
  update: (node: TreeNode) => TreeNode
): TreeNode[] {
  return nodes.map((node) => {
    if (node.id === id) return update(node)
    if (node.children && id.startsWith(`${node.id}/`)) {
      return { ...node, children: updateNode(node.children, id, update) }
    }
    return node
  })
}

/** Drop every expansion entry at or below the given connection id. */
function pruneExpansion(
  expanded: Record<string, boolean>,
  id: string
): Record<string, boolean> {
  const next: Record<string, boolean> = {}
  for (const key of Object.keys(expanded)) {
    if (key !== id && !key.startsWith(`${id}/`)) next[key] = expanded[key]
  }
  return next
}

export function useConnectionState(): ConnectionState {
  const [tree, setTree] = useState<TreeNode[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [mode, setMode] = useState<TreeMode>('A')
  const [filter, setFilter] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [profiles, setProfiles] = useState<Record<string, SavedConnection>>({})
  const [schemas, setSchemas] = useState<
    Record<string, Record<string, DatabaseIntrospection>>
  >({})

  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogTab, setDialogTab] = useState<DialogTab>('params')
  const [showPwd, setShowPwd] = useState(false)
  const [testState, setTestState] = useState<TestState>('idle')
  const [testMsg, setTestMsg] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [form, setForm] = useState<ConnectionForm>(() => defaultForm())
  const [editingId, setEditingId] = useState<string | null>(null)

  /** Bumped whenever an in-flight test's result should be discarded. */
  const testSeq = useRef(0)

  /** Mirror of `schemas` so ensureSchema doesn't go stale across renders. */
  const schemasRef = useRef(schemas)
  schemasRef.current = schemas
  /** connId + database pairs with an introspection request in flight. */
  const introspecting = useRef(new Set<string>())

  const cacheSchema = useCallback(
    (connId: string, db: DatabaseIntrospection) => {
      setSchemas((prev) => ({
        ...prev,
        [connId]: { ...prev[connId], [db.name]: db }
      }))
    },
    []
  )

  const dropSchemas = useCallback((connId: string) => {
    setSchemas((prev) => {
      if (!(connId in prev)) return prev
      const next = { ...prev }
      delete next[connId]
      return next
    })
  }, [])

  const ensureSchema = useCallback(
    async (connId: string, database: string) => {
      if (schemasRef.current[connId]?.[database]) return
      const key = `${connId}\u0000${database}`
      if (introspecting.current.has(key)) return
      introspecting.current.add(key)
      try {
        const res = await window.dbDesk.db.introspect(connId, database)
        if (res.ok) cacheSchema(connId, res.data)
      } finally {
        introspecting.current.delete(key)
      }
    },
    [cacheSchema]
  )

  // Saved connections appear on launch as offline nodes; nothing auto-connects.
  useEffect(() => {
    let cancelled = false
    void window.dbDesk.store.list().then((saved) => {
      if (cancelled) return
      setProfiles(
        Object.fromEntries(saved.map((profile) => [profile.id, profile]))
      )
      setTree(saved.map(savedConnectionNode))
    })
    return () => {
      cancelled = true
    }
  }, [])

  const loadDatabase = useCallback(async (node: TreeNode) => {
    const dbNodeId = node.id
    const connId = dbNodeId.split('/')[0]
    const dbName = node.label
    const connType = profiles[connId]?.type
    setTree((prev) =>
      updateNode(prev, dbNodeId, (n) => ({ ...n, loading: true }))
    )
    const res = await window.dbDesk.db.introspect(connId, dbName)
    if (res.ok) cacheSchema(connId, res.data)
    setTree((prev) =>
      updateNode(prev, dbNodeId, (n) => {
        if (!res.ok) return { ...n, loading: false }
        const next: TreeNode = {
          ...n,
          loading: false,
          lazy: false,
          children: databaseChildren(res.data, connType)
        }
        next.children!.forEach((child) => assignIds(child, next.id))
        return next
      })
    )
    if (!res.ok) {
      setLoadError(`${dbName}: ${res.error}`)
      setExpanded((prev) => {
        const next = { ...prev }
        delete next[dbNodeId]
        return next
      })
    }
  }, [cacheSchema, profiles])

  const toggleRow = useCallback(
    (id: string, expandable: boolean) => {
      setSelected(id)
      if (!expandable) return
      const willExpand = !expanded[id]
      setExpanded((prev) => {
        const next = { ...prev }
        if (next[id]) delete next[id]
        else next[id] = true
        return next
      })
      if (willExpand) {
        const node = findNode(id, tree)
        if (node?.kind === 'database' && node.lazy && !node.loading)
          void loadDatabase(node)
      }
    },
    [expanded, tree, loadDatabase]
  )

  const collapseAll = useCallback(() => {
    setExpanded({})
    setFilter('')
  }, [])

  /** Expand a chain of ancestor rows and select a node (references navigation). */
  const reveal = useCallback((expandIds: string[], selectId: string) => {
    setExpanded((prev) => {
      const next = { ...prev }
      for (const id of expandIds) next[id] = true
      return next
    })
    setSelected(selectId)
  }, [])

  /** Re-introspect every loaded database of a connection (context-menu Refresh). */
  const refreshConnection = useCallback(
    (id: string) => {
      const conn = findNode(id, tree)
      if (conn?.kind !== 'connection' || conn.status !== 'online') return
      for (const db of conn.children ?? []) {
        if (db.kind === 'database' && !db.lazy && !db.loading && db.children) {
          void loadDatabase(db)
        }
      }
    },
    [tree, loadDatabase]
  )

  const clearLoadError = useCallback(() => setLoadError(null), [])

  /** Connect a saved (offline) connection; on failure, reopen the dialog to fix credentials. */
  const connectSaved = useCallback(
    async (id: string) => {
      const profile = profiles[id]
      if (!profile) return
      const node = findNode(id, tree)
      if (!node || node.status === 'online' || node.loading) return

      setTree((prev) => updateNode(prev, id, (n) => ({ ...n, loading: true })))
      const res = await window.dbDesk.db.connectSaved(id)
      if (res.ok) {
        cacheSchema(id, res.data.connectedDatabase)
        const conn = connectionNodeFromResult(profile, res.data)
        setTree((prev) => prev.map((n) => (n.id === id ? conn : n)))
        setExpanded((prev) => ({
          ...prev,
          ...defaultExpansion(conn, res.data.connectedDatabase.name)
        }))
        setSelected(id)
        return
      }

      setTree((prev) => updateNode(prev, id, (n) => ({ ...n, loading: false })))
      const needsPassword = !profile.hasPassword && /password/i.test(res.error)
      testSeq.current++
      setForm(formFromSaved(profile))
      setDialogTab(profile.useUrl ? 'url' : 'params')
      setShowPwd(false)
      setConnecting(false)
      setEditingId(id)
      setTestState('error')
      setTestMsg(needsPassword ? 'Enter your password to connect.' : res.error)
      setDialogOpen(true)
    },
    [profiles, tree, cacheSchema]
  )

  const disconnectConnection = useCallback(
    (id: string) => {
      void window.dbDesk.db.disconnect(id)
      dropSchemas(id)
      setTree((prev) =>
        updateNode(prev, id, (n) => ({
          ...n,
          status: 'offline' as const,
          children: undefined,
          loading: false
        }))
      )
      setExpanded((prev) => pruneExpansion(prev, id))
      setSelected((prev) =>
        prev && (prev === id || prev.startsWith(`${id}/`)) ? id : prev
      )
    },
    [dropSchemas]
  )

  const removeConnection = useCallback(
    (id: string) => {
      void window.dbDesk.db.disconnect(id)
      // store:delete now unlinks the connection's knowledge links in main;
      // bases themselves survive, so there is nothing to delete here.
      void window.dbDesk.store.delete(id)
      void window.dbDesk.files.deleteForConnection(id)
      dropSchemas(id)
      setProfiles((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      setExpanded((prev) => pruneExpansion(prev, id))
      setTree((prev) => prev.filter((conn) => conn.id !== id))
      setSelected((prev) =>
        prev && (prev === id || prev.startsWith(`${id}/`)) ? null : prev
      )
    },
    [dropSchemas]
  )

  const removeSelected = useCallback(() => {
    const node = findNode(selected, tree)
    if (node?.kind === 'connection') removeConnection(node.id)
  }, [selected, tree, removeConnection])

  const openDialog = useCallback(() => {
    // Always start from a clean form: leftovers from a canceled attempt or
    // an edit of a saved connection must not leak into a new profile.
    testSeq.current++
    setForm(defaultForm())
    setDialogTab('params')
    setEditingId(null)
    setShowPwd(false)
    setTestState('idle')
    setTestMsg('')
    setConnecting(false)
    setDialogOpen(true)
  }, [])

  const closeDialog = useCallback(() => {
    testSeq.current++
    setDialogOpen(false)
  }, [])

  /** Switch dialog tabs; leaving the URL tab fills the parameter fields from the URL. */
  const changeDialogTab = useCallback(
    (tab: DialogTab) => {
      if (tab === 'params' && dialogTab === 'url') {
        const parsed = parseConnectionUrl(form.url)
        if (parsed) {
          setForm((prev) => ({
            ...prev,
            host: parsed.host || prev.host,
            port: parsed.port || prev.port,
            database: parsed.database || prev.database,
            user: parsed.user || prev.user,
            password: parsed.password || prev.password
          }))
        }
      }
      setDialogTab(tab)
    },
    [dialogTab, form.url]
  )

  /**
   * Switch the engine for a new connection. The form resets to the new
   * type's defaults; a custom name the user already typed is kept.
   */
  const setDialogType = useCallback((type: ConnectionType) => {
    testSeq.current++
    setTestState('idle')
    setTestMsg('')
    setDialogTab('params')
    setForm((prev) => {
      if (prev.type === type) return prev
      const next = defaultForm(type)
      const prevDefaultName = defaultForm(prev.type).name
      return prev.name && prev.name !== prevDefaultName
        ? { ...next, name: prev.name }
        : next
    })
  }, [])

  const togglePwd = useCallback(() => setShowPwd((prev) => !prev), [])
  const toggleSavePwd = useCallback(
    () => setForm((prev) => ({ ...prev, savePwd: !prev.savePwd })),
    []
  )

  const updateForm = useCallback((key: keyof ConnectionForm, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    testSeq.current++
    setTestState('idle')
    setTestMsg('')
  }, [])

  const testConnection = useCallback(async () => {
    const seq = ++testSeq.current
    setTestState('testing')
    setTestMsg('Connecting…')
    const res = await window.dbDesk.db.test(toParams(form, dialogTab === 'url'))
    if (seq !== testSeq.current) return
    if (res.ok) {
      setTestState('ok')
      const engine = dialectFor(form.type).engine
      const version = res.data.serverVersion
        ? `${engine} ${res.data.serverVersion}`
        : engine
      setTestMsg(
        `Connected · ${version} · ${res.data.latencyMs} ms${
          res.data.ssl ? ' · SSL' : ''
        }`
      )
    } else {
      setTestState('error')
      setTestMsg(res.error || 'Connection failed')
    }
  }, [form, dialogTab])

  const connect = useCallback(async () => {
    if (connecting) return
    setConnecting(true)
    const connId = editingId ?? `c-${Date.now()}-${nextConnectionSeq++}`
    const params = toParams(form, dialogTab === 'url')
    const res = await window.dbDesk.db.connect(connId, params)
    if (!res.ok) {
      setConnecting(false)
      setTestState('error')
      setTestMsg(res.error || 'Connection failed')
      return
    }

    const fallbackName = dialectFor(form.type).label
    const name = (form.name || fallbackName).trim() || fallbackName
    let saved: SavedConnection
    try {
      saved = await window.dbDesk.store.save(connId, name, params, form.savePwd)
    } catch {
      // Persisting failed (e.g. disk error) — keep the live connection usable.
      saved = {
        id: connId,
        name,
        type: form.type,
        host: form.host,
        port: form.port,
        database: form.database,
        user: form.user,
        httpPath: form.httpPath,
        url: form.url,
        useUrl: params.useUrl,
        hasPassword: false
      }
    }
    setConnecting(false)
    setProfiles((prev) => ({ ...prev, [saved.id]: saved }))
    cacheSchema(connId, res.data.connectedDatabase)

    const conn = connectionNodeFromResult(saved, res.data)
    setTree((prev) =>
      prev.some((n) => n.id === conn.id)
        ? prev.map((n) => (n.id === conn.id ? conn : n))
        : [...prev, conn]
    )
    setExpanded((prev) => ({
      ...prev,
      ...defaultExpansion(conn, res.data.connectedDatabase.name)
    }))
    setSelected(conn.id)
    setDialogOpen(false)
    setEditingId(null)
    setTestState('idle')
    setTestMsg('')
    setForm(defaultForm())
    setDialogTab('params')
  }, [form, dialogTab, connecting, editingId, cacheSchema])

  const selectedNode = useMemo(() => findNode(selected, tree), [selected, tree])
  const canRemove = selectedNode?.kind === 'connection'

  return {
    tree,
    expanded,
    selected,
    mode,
    filter,
    selectedNode,
    canRemove,
    loadError,
    schemas,
    ensureSchema,
    dialogOpen,
    dialogTab,
    showPwd,
    testState,
    testMsg,
    connecting,
    form,
    editingId,
    setMode,
    setFilter,
    toggleRow,
    collapseAll,
    removeSelected,
    clearLoadError,
    reveal,
    connectSaved: (id: string) => void connectSaved(id),
    disconnectConnection,
    removeConnection,
    refreshConnection,
    openDialog,
    closeDialog,
    setDialogTab: changeDialogTab,
    setDialogType,
    togglePwd,
    toggleSavePwd,
    updateForm,
    testConnection: () => void testConnection(),
    connect: () => void connect()
  }
}
