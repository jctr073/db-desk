import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  buildInitialTree,
  connectionFromForm,
  defaultForm,
  findNode,
  initialExpanded,
  initialSelected
} from './treeData'
import type { ConnectionForm, TreeMode, TreeNode } from './types'

export type TestState = 'idle' | 'testing' | 'ok'
export type DialogTab = 'params' | 'url'

export interface ConnectionState {
  tree: TreeNode[]
  expanded: Record<string, boolean>
  selected: string | null
  mode: TreeMode
  filter: string
  selectedNode: TreeNode | null
  canRemove: boolean

  dialogOpen: boolean
  dialogTab: DialogTab
  showPwd: boolean
  testState: TestState
  testMsg: string
  form: ConnectionForm

  setMode: (mode: TreeMode) => void
  setFilter: (value: string) => void
  toggleRow: (id: string, expandable: boolean) => void
  collapseAll: () => void
  removeSelected: () => void

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

export function useConnectionState(): ConnectionState {
  const [tree, setTree] = useState<TreeNode[]>(() => buildInitialTree())
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => initialExpanded())
  const [selected, setSelected] = useState<string | null>(initialSelected)
  const [mode, setMode] = useState<TreeMode>('A')
  const [filter, setFilter] = useState('')

  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogTab, setDialogTab] = useState<DialogTab>('params')
  const [showPwd, setShowPwd] = useState(false)
  const [testState, setTestState] = useState<TestState>('idle')
  const [testMsg, setTestMsg] = useState('')
  const [form, setForm] = useState<ConnectionForm>(() => defaultForm())

  const testTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(testTimer.current), [])

  const toggleRow = useCallback((id: string, expandable: boolean) => {
    setSelected(id)
    if (!expandable) return
    setExpanded((prev) => {
      const next = { ...prev }
      if (next[id]) delete next[id]
      else next[id] = true
      return next
    })
  }, [])

  const collapseAll = useCallback(() => {
    setExpanded({})
    setFilter('')
  }, [])

  const removeSelected = useCallback(() => {
    setTree((prev) => {
      const node = findNode(selected, prev)
      if (!node || node.kind !== 'connection') return prev
      const next = prev.filter((conn) => conn.id !== node.id)
      setSelected(next.length ? next[0].id : null)
      return next
    })
  }, [selected])

  const resetDialog = useCallback(() => {
    setDialogTab('params')
    setShowPwd(false)
    setTestState('idle')
    setTestMsg('')
    setForm(defaultForm())
  }, [])

  const openDialog = useCallback(() => {
    resetDialog()
    setDialogOpen(true)
  }, [resetDialog])

  const closeDialog = useCallback(() => {
    clearTimeout(testTimer.current)
    setDialogOpen(false)
  }, [])

  const togglePwd = useCallback(() => setShowPwd((prev) => !prev), [])
  const toggleSavePwd = useCallback(
    () => setForm((prev) => ({ ...prev, savePwd: !prev.savePwd })),
    []
  )

  const updateForm = useCallback((key: keyof ConnectionForm, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    setTestState('idle')
    setTestMsg('')
  }, [])

  const testConnection = useCallback(() => {
    setTestState('testing')
    setTestMsg('Connecting…')
    clearTimeout(testTimer.current)
    testTimer.current = setTimeout(() => {
      setTestState('ok')
      setTestMsg('Connected · PostgreSQL 16.2 · 41 ms')
    }, 950)
  }, [])

  const connect = useCallback(() => {
    const conn = connectionFromForm(form, `c-${Date.now()}-${nextConnectionSeq++}`)
    setTree((prev) => [...prev, conn])
    setExpanded((prev) => ({ ...prev, [conn.id]: true }))
    setSelected(conn.id)
    setDialogOpen(false)
    setTestState('idle')
    setTestMsg('')
  }, [form])

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
    dialogOpen,
    dialogTab,
    showPwd,
    testState,
    testMsg,
    form,
    setMode,
    setFilter,
    toggleRow,
    collapseAll,
    removeSelected,
    openDialog,
    closeDialog,
    setDialogTab,
    togglePwd,
    toggleSavePwd,
    updateForm,
    testConnection,
    connect
  }
}
