import { useCallback, useMemo, useRef, useState } from 'react'

import type { ConnectParams } from '../../../shared/db'
import {
  assignIds,
  connectionNodeFromResult,
  databaseChildren,
  defaultExpansion,
  defaultForm,
  findNode
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

  dialogOpen: boolean
  dialogTab: DialogTab
  showPwd: boolean
  testState: TestState
  testMsg: string
  connecting: boolean
  form: ConnectionForm

  setMode: (mode: TreeMode) => void
  setFilter: (value: string) => void
  toggleRow: (id: string, expandable: boolean) => void
  collapseAll: () => void
  removeSelected: () => void
  clearLoadError: () => void

  openDialog: () => void
  closeDialog: () => void
  setDialogTab: (tab: DialogTab) => void
  togglePwd: () => void
  toggleSavePwd: () => void
  updateForm: (key: keyof ConnectionForm, value: string) => void
  testConnection: () => void
  connect: () => void
}

let nextConnectionSeq = 0

function toParams(form: ConnectionForm, useUrl: boolean): ConnectParams {
  return {
    host: form.host,
    port: form.port,
    database: form.database,
    user: form.user,
    password: form.password,
    url: form.url,
    useUrl
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

export function useConnectionState(): ConnectionState {
  const [tree, setTree] = useState<TreeNode[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [mode, setMode] = useState<TreeMode>('A')
  const [filter, setFilter] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogTab, setDialogTab] = useState<DialogTab>('params')
  const [showPwd, setShowPwd] = useState(false)
  const [testState, setTestState] = useState<TestState>('idle')
  const [testMsg, setTestMsg] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [form, setForm] = useState<ConnectionForm>(() => defaultForm())

  /** Bumped whenever an in-flight test's result should be discarded. */
  const testSeq = useRef(0)

  const loadDatabase = useCallback(async (node: TreeNode) => {
    const dbNodeId = node.id
    const connId = dbNodeId.split('/')[0]
    const dbName = node.label
    setTree((prev) => updateNode(prev, dbNodeId, (n) => ({ ...n, loading: true })))
    const res = await window.dbDesk.db.introspect(connId, dbName)
    setTree((prev) =>
      updateNode(prev, dbNodeId, (n) => {
        if (!res.ok) return { ...n, loading: false }
        const next: TreeNode = {
          ...n,
          loading: false,
          lazy: false,
          children: databaseChildren(res.data)
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
  }, [])

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
        if (node?.kind === 'database' && node.lazy && !node.loading) void loadDatabase(node)
      }
    },
    [expanded, tree, loadDatabase]
  )

  const collapseAll = useCallback(() => {
    setExpanded({})
    setFilter('')
  }, [])

  const removeSelected = useCallback(() => {
    const node = findNode(selected, tree)
    if (!node || node.kind !== 'connection') return
    void window.dbDesk.db.disconnect(node.key ?? node.id)
    setTree((prev) => {
      const next = prev.filter((conn) => conn.id !== node.id)
      setSelected(next.length ? next[0].id : null)
      return next
    })
  }, [selected, tree])

  const clearLoadError = useCallback(() => setLoadError(null), [])

  const resetDialog = useCallback(() => {
    setDialogTab('params')
    setShowPwd(false)
    setTestState('idle')
    setTestMsg('')
    setConnecting(false)
    setForm(defaultForm())
  }, [])

  const openDialog = useCallback(() => {
    resetDialog()
    setDialogOpen(true)
  }, [resetDialog])

  const closeDialog = useCallback(() => {
    testSeq.current++
    setDialogOpen(false)
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
      setTestMsg(`Connected · PostgreSQL ${res.data.serverVersion} · ${res.data.latencyMs} ms`)
    } else {
      setTestState('error')
      setTestMsg(res.error)
    }
  }, [form, dialogTab])

  const connect = useCallback(async () => {
    if (connecting) return
    setConnecting(true)
    const connId = `c-${Date.now()}-${nextConnectionSeq++}`
    const res = await window.dbDesk.db.connect(connId, toParams(form, dialogTab === 'url'))
    setConnecting(false)
    if (!res.ok) {
      setTestState('error')
      setTestMsg(res.error)
      return
    }
    const conn = connectionNodeFromResult(form, dialogTab === 'url', connId, res.data)
    setTree((prev) => [...prev, conn])
    setExpanded((prev) => ({
      ...prev,
      ...defaultExpansion(conn, res.data.connectedDatabase.name)
    }))
    setSelected(conn.id)
    setDialogOpen(false)
    setTestState('idle')
    setTestMsg('')
  }, [form, dialogTab, connecting])

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
    dialogOpen,
    dialogTab,
    showPwd,
    testState,
    testMsg,
    connecting,
    form,
    setMode,
    setFilter,
    toggleRow,
    collapseAll,
    removeSelected,
    clearLoadError,
    openDialog,
    closeDialog,
    setDialogTab,
    togglePwd,
    toggleSavePwd,
    updateForm,
    testConnection: () => void testConnection(),
    connect: () => void connect()
  }
}
