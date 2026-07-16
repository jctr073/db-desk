import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { parseConnectionUrl } from '../../../shared/connectionUrl'
import type {
  ConnectParams,
  DatabaseIntrospection,
  SavedConnection
} from '../../../shared/db'
import { dialectFor } from '../../../shared/dialect'
import type { ConnectionType } from '../../../shared/dialect'
import type { SchemaSelectionConfig } from '../../../shared/schemaSelection'
import {
  assignIds,
  connectionNodeFromResult,
  databaseChildren,
  defaultExpansion,
  defaultForm,
  findNode,
  formFromSaved,
  savedConnectionNode,
  schemaCounts
} from './treeData'
import type { ConnectionForm, TreeMode, TreeNode } from './types'

export type TestState = 'idle' | 'testing' | 'ok' | 'error'
export type DialogTab = 'params' | 'url'

/** The unified hierarchical catalog/schema picker (Databricks). */
export interface ManageDialogState {
  connId: string
  catalogs: string[] | null
  config: SchemaSelectionConfig | null
  schemaLists: Record<string, string[] | undefined>
  schemaErrors: Record<string, string | undefined>
  initialExpanded?: string
  error?: string
}

export interface ConnectionState {
  tree: TreeNode[]
  expanded: Record<string, boolean>
  selected: string | null
  /** The app-wide active connection (unified context); null when none. */
  activeConnId: string | null
  /** Make a connection the whole-app context, connecting it first if offline. */
  activateConnection: (id: string) => void
  mode: TreeMode
  filter: string
  selectedNode: TreeNode | null
  canRemove: boolean
  loadError: string | null

  /** Raw introspection per connection id, then per database name. */
  schemas: Record<string, Record<string, DatabaseIntrospection>>
  /** Introspect and cache a database if it isn't cached already. */
  ensureSchema: (connId: string, database: string) => void

  /** Hierarchical catalog/schema picker (Databricks); null when closed. */
  manageDialog: ManageDialogState | null
  openManageCatalogs: (
    connId: string,
    initialExpanded?: string,
    availableSchemas?: string[]
  ) => void
  loadManageCatalogSchemas: (catalog: string) => void
  /** Persist both hierarchy levels and reload what they affect. */
  saveManageSelection: (config: SchemaSelectionConfig) => Promise<void>
  closeManageDialog: () => void

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
  const [activeConnId, setActiveConnId] = useState<string | null>(null)
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
  const [manageDialog, setManageDialog] = useState<ManageDialogState | null>(
    null
  )

  /** Bumped whenever an in-flight test's result should be discarded. */
  const testSeq = useRef(0)

  /** Mirror of `schemas` so ensureSchema doesn't go stale across renders. */
  const schemasRef = useRef(schemas)
  schemasRef.current = schemas
  /** Mirror of `tree` for callbacks that must not re-bind on every tree change. */
  const treeRef = useRef(tree)
  treeRef.current = tree
  /** connId + database pairs with an introspection request in flight. */
  const introspecting = useRef(new Set<string>())
  /** Catalog schema-list requests in flight for the manage dialog. */
  const manageSchemaLoads = useRef(new Set<string>())
  const manageDialogRef = useRef(manageDialog)
  manageDialogRef.current = manageDialog

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

  const dropSchema = useCallback((connId: string, database: string) => {
    setSchemas((prev) => {
      if (!prev[connId]?.[database]) return prev
      const forConn = { ...prev[connId] }
      delete forConn[database]
      return { ...prev, [connId]: forConn }
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
        // A needsSchemaSelection result is a prompt, not an introspection;
        // caching it would make the database look loaded-but-empty.
        if (res.ok && !res.data.needsSchemaSelection)
          cacheSchema(connId, res.data)
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
      // The active-context designation survives relaunch; the connection
      // itself comes back offline (nothing auto-connects).
      const storedActive = localStorage.getItem('conn.activeId')
      if (storedActive && saved.some((profile) => profile.id === storedActive)) {
        setActiveConnId(storedActive)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (activeConnId) localStorage.setItem('conn.activeId', activeConnId)
    else localStorage.removeItem('conn.activeId')
  }, [activeConnId])

  const closeManageDialog = useCallback(() => setManageDialog(null), [])

  /** Fill the open picker unless it was closed or replaced. */
  const fillManageDialog = useCallback(
    (opened: ManageDialogState, fill: Partial<ManageDialogState>) => {
      setManageDialog((prev) =>
        prev && prev.connId === opened.connId ? { ...prev, ...fill } : prev
      )
    },
    []
  )

  const openManageCatalogs = useCallback(
    (connId: string, initialExpanded?: string, availableSchemas?: string[]) => {
      const opened: ManageDialogState = {
        connId,
        catalogs: null,
        config: null,
        schemaLists:
          initialExpanded && availableSchemas
            ? { [initialExpanded]: availableSchemas }
            : {},
        schemaErrors: {},
        initialExpanded
      }
      setManageDialog(opened)
      void (async () => {
        try {
          const [config, res] = await Promise.all([
            window.dbDesk.store.getSchemaConfig(connId),
            window.dbDesk.db.listCatalogs(connId)
          ])
          if (res.ok) {
            fillManageDialog(opened, {
              catalogs:
                initialExpanded && !res.data.includes(initialExpanded)
                  ? [initialExpanded, ...res.data]
                  : res.data,
              config
            })
          } else {
            fillManageDialog(opened, { error: res.error })
          }
        } catch (err) {
          fillManageDialog(opened, {
            error: err instanceof Error ? err.message : String(err)
          })
        }
      })()
    },
    [fillManageDialog]
  )

  const loadManageCatalogSchemas = useCallback((catalog: string) => {
    const dialog = manageDialogRef.current
    if (!dialog || dialog.schemaLists[catalog] !== undefined) return
    const key = `${dialog.connId}\u0000${catalog}`
    if (manageSchemaLoads.current.has(key)) return
    manageSchemaLoads.current.add(key)
    void window.dbDesk.db
      .listSchemas(dialog.connId, catalog)
      .then((res) => {
        setManageDialog((previous) => {
          if (!previous || previous.connId !== dialog.connId) return previous
          if (res.ok) {
            return {
              ...previous,
              schemaLists: { ...previous.schemaLists, [catalog]: res.data }
            }
          }
          return {
            ...previous,
            schemaErrors: { ...previous.schemaErrors, [catalog]: res.error }
          }
        })
      })
      .catch((cause) => {
        setManageDialog((previous) =>
          previous && previous.connId === dialog.connId
            ? {
                ...previous,
                schemaErrors: {
                  ...previous.schemaErrors,
                  [catalog]:
                    cause instanceof Error ? cause.message : String(cause)
                }
              }
            : previous
        )
      })
      .finally(() => manageSchemaLoads.current.delete(key))
  }, [])

  const loadDatabase = useCallback(
    async (node: TreeNode) => {
      const dbNodeId = node.id
      const connId = dbNodeId.split('/')[0]
      const dbName = node.label
      const connType = profiles[connId]?.type
      setTree((prev) =>
        updateNode(prev, dbNodeId, (n) => ({ ...n, loading: true }))
      )
      const res = await window.dbDesk.db.introspect(connId, dbName)
      if (res.ok && res.data.needsSchemaSelection) {
        // Large catalog with no saved schema selection: leave the node lazy
        // and collapsed, and open the picker instead of loading everything.
        setTree((prev) =>
          updateNode(prev, dbNodeId, (n) => ({ ...n, loading: false }))
        )
        setExpanded((prev) => {
          const next = { ...prev }
          delete next[dbNodeId]
          return next
        })
        openManageCatalogs(connId, dbName, res.data.availableSchemas ?? [])
        return
      }
      if (res.ok) cacheSchema(connId, res.data)
      setTree((prev) =>
        updateNode(prev, dbNodeId, (n) => {
          if (!res.ok) return { ...n, loading: false }
          const counts = schemaCounts(res.data)
          const next: TreeNode = {
            ...n,
            loading: false,
            lazy: false,
            pinnedSchemaCount: counts.pinnedSchemaCount,
            totalSchemaCount: counts.totalSchemaCount,
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
    },
    [cacheSchema, profiles, openManageCatalogs]
  )

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

  const saveManageSelection = useCallback(
    async (config: SchemaSelectionConfig) => {
      const dialog = manageDialog
      if (!dialog) return
      await window.dbDesk.store.setSchemaConfig(dialog.connId, config)
      setManageDialog(null)
      const conn = tree.find((n) => n.id === dialog.connId)
      if (!conn || conn.status !== 'online') return
      const keep = config.catalogs ? new Set(config.catalogs) : null
      const currentNames = (conn.children ?? []).map((child) => child.label)
      const allNames =
        dialog.catalogs && dialog.catalogs.length > 0
          ? dialog.catalogs
          : currentNames
      const nextNames = allNames.filter((name) => !keep || keep.has(name))
      const removed = currentNames.filter((name) => !nextNames.includes(name))
      const reload = (conn.children ?? []).filter(
        (node) =>
          node.kind === 'database' &&
          nextNames.includes(node.label) &&
          (!!node.children || node.label === dialog.initialExpanded)
      )

      for (const name of currentNames) dropSchema(dialog.connId, name)
      if (removed.length > 0) {
        setExpanded((prev) => {
          const next = { ...prev }
          const prefixes = removed.map((name) => `${dialog.connId}/${name}`)
          for (const key of Object.keys(next)) {
            if (
              prefixes.some(
                (prefix) => key === prefix || key.startsWith(`${prefix}/`)
              )
            ) {
              delete next[key]
            }
          }
          return next
        })
      }
      setTree((prev) =>
        prev.map((n) => {
          if (n.id !== dialog.connId) return n
          const existing = new Map(
            (n.children ?? []).map((child) => [child.label, child])
          )
          const children = nextNames.map((name) => {
            const prevChild = existing.get(name)
            if (prevChild) {
              return {
                ...prevChild,
                children: undefined,
                lazy: true,
                loading: false,
                pinnedSchemaCount: undefined,
                totalSchemaCount: undefined
              }
            }
            const child: TreeNode = {
              id: '',
              kind: 'database',
              key: name,
              label: name,
              lazy: true
            }
            assignIds(child, n.id)
            return child
          })
          return { ...n, children }
        })
      )
      for (const node of reload) {
        setExpanded((previous) => ({ ...previous, [node.id]: true }))
        void loadDatabase({
          ...node,
          children: undefined,
          lazy: true,
          loading: false
        })
      }
    },
    [manageDialog, tree, dropSchema, loadDatabase]
  )

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
        const connected = res.data.connectedDatabase
        const conn = connectionNodeFromResult(profile, res.data)
        const connectedVisible = conn.children?.some(
          (child) => child.label === connected.name
        )
        if (connectedVisible && !connected.needsSchemaSelection) {
          cacheSchema(id, connected)
        }
        setTree((prev) => prev.map((n) => (n.id === id ? conn : n)))
        setExpanded((prev) => ({
          ...prev,
          ...defaultExpansion(conn, connected.name)
        }))
        setSelected(id)
        // Connecting is activating: the connection becomes the app context.
        setActiveConnId(id)
        if (connectedVisible && connected.needsSchemaSelection) {
          openManageCatalogs(
            id,
            connected.name,
            connected.availableSchemas ?? []
          )
        }
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
    [profiles, tree, cacheSchema, openManageCatalogs]
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
      // The app context moves to another online connection, if there is one.
      setActiveConnId((act) => {
        if (act !== id) return act
        const fallback = treeRef.current.find(
          (node) => node.id !== id && node.status === 'online'
        )
        return fallback?.id ?? null
      })
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
      setActiveConnId((act) => {
        if (act !== id) return act
        const fallback = treeRef.current.find(
          (node) => node.id !== id && node.status === 'online'
        )
        return fallback?.id ?? null
      })
    },
    [dropSchemas]
  )

  const removeSelected = useCallback(() => {
    const node = findNode(selected, tree)
    if (node?.kind === 'connection') removeConnection(node.id)
  }, [selected, tree, removeConnection])

  /**
   * Unified context: make one connection the whole-app target. Online
   * connections switch instantly; offline ones connect first (connectSaved
   * activates on success).
   */
  const activateConnection = useCallback(
    (id: string) => {
      const node = treeRef.current.find((n) => n.id === id)
      if (!node || node.loading) return
      if (node.status === 'online') {
        setActiveConnId(id)
        setSelected(id)
      } else {
        void connectSaved(id)
      }
    },
    [connectSaved]
  )

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
    const connected = res.data.connectedDatabase

    const conn = connectionNodeFromResult(saved, res.data)
    const connectedVisible = conn.children?.some(
      (child) => child.label === connected.name
    )
    if (connectedVisible && !connected.needsSchemaSelection) {
      cacheSchema(connId, connected)
    }
    setTree((prev) =>
      prev.some((n) => n.id === conn.id)
        ? prev.map((n) => (n.id === conn.id ? conn : n))
        : [...prev, conn]
    )
    setExpanded((prev) => ({
      ...prev,
      ...defaultExpansion(conn, connected.name)
    }))
    setSelected(conn.id)
    setActiveConnId(conn.id)
    setDialogOpen(false)
    setEditingId(null)
    setTestState('idle')
    setTestMsg('')
    setForm(defaultForm())
    setDialogTab('params')
    if (connectedVisible && connected.needsSchemaSelection) {
      openManageCatalogs(
        connId,
        connected.name,
        connected.availableSchemas ?? []
      )
    }
  }, [form, dialogTab, connecting, editingId, cacheSchema, openManageCatalogs])

  const selectedNode = useMemo(() => findNode(selected, tree), [selected, tree])
  const canRemove = selectedNode?.kind === 'connection'

  return {
    tree,
    expanded,
    selected,
    activeConnId,
    activateConnection,
    mode,
    filter,
    selectedNode,
    canRemove,
    loadError,
    schemas,
    ensureSchema,
    manageDialog,
    openManageCatalogs,
    loadManageCatalogSchemas,
    saveManageSelection,
    closeManageDialog,
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
