import { useEffect, useRef } from 'react'
import type { MouseEvent as ReactMouseEvent, MutableRefObject, ReactElement } from 'react'

import { supportedExtension } from '../../../../shared/files'
import type { FileKind } from '../../../../shared/files'
import type { QueryFile } from '../../files/useFileState'
import {
  CloseIcon,
  DatabaseIcon,
  EyeIcon,
  FormatIcon,
  KebabIcon,
  LockIcon,
  PlayIcon,
  PlusThinIcon,
  SaveIcon,
  SparkleIcon,
  SqlFileIcon
} from '../icons'
import type { QueryTarget, ResultTab } from '../useQueryRunner'
import { useEscapeKey } from '../../useEscapeKey'

/** Open files bucketed by (connection, database) — one top-tier tab each. */
export interface FileGroup {
  key: string
  connId: string
  database: string | null
  files: QueryFile[]
  previews: ResultTab[]
}

export interface TabMenu {
  fileId: string
  x: number
  y: number
}

/** Fixed-position style dropping a menu below its button, right-aligned. */
function menuPosition(button: HTMLButtonElement): {
  top: number
  right: number
} {
  const rect = button.getBoundingClientRect()
  return { top: rect.bottom + 6, right: window.innerWidth - rect.right }
}

interface EditorTabStripProps {
  groups: FileGroup[]
  selectedFileId: string | null
  activePreview: ResultTab | null
  dirtyIds: ReadonlySet<string>
  renamingFileId: string | null
  renameDraft: string
  onRenameDraftChange: (draft: string) => void
  onRenameCommit: () => void
  onRenameCancel: () => void
  onSelectFile: (id: string) => void
  onTabContextMenu: (event: ReactMouseEvent<HTMLDivElement>, file: QueryFile) => void
  onCloseFile: (file: QueryFile) => void
  onSelectResultTab: (id: string | null) => void
  onCloseResultTab: (id: string) => void
  /** Anchor refs live in the panel: the menus position against them. */
  newFileBtnRef: MutableRefObject<HTMLButtonElement | null>
  newFileMenuOpen: boolean
  newFileDisabled: boolean
  onToggleNewFileMenu: () => void
  target: QueryTarget | null
  isSqlFile: boolean
  onRun: () => void
  isFilePreview: boolean
  onExitFilePreview: () => void
  onEnterFilePreview: () => void
  actionsBtnRef: MutableRefObject<HTMLButtonElement | null>
  actionsOpen: boolean
  onToggleActions: () => void
}

/** The editor's top bar: file tabs, preview tabs, target chip, Run, kebab. */
export function EditorTabStrip({
  groups,
  selectedFileId,
  activePreview,
  dirtyIds,
  renamingFileId,
  renameDraft,
  onRenameDraftChange,
  onRenameCommit,
  onRenameCancel,
  onSelectFile,
  onTabContextMenu,
  onCloseFile,
  onSelectResultTab,
  onCloseResultTab,
  newFileBtnRef,
  newFileMenuOpen,
  newFileDisabled,
  onToggleNewFileMenu,
  target,
  isSqlFile,
  onRun,
  isFilePreview,
  onExitFilePreview,
  onEnterFilePreview,
  actionsBtnRef,
  actionsOpen,
  onToggleActions
}: EditorTabStripProps): ReactElement {
  const renameInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const input = renameInputRef.current
    if (!renamingFileId || !input) return
    input.focus()
    const extensionStart = supportedExtension(input.value)
      ? input.value.length - supportedExtension(input.value)!.length
      : input.value.length
    input.setSelectionRange(0, extensionStart)
  }, [renamingFileId])

  return (
    <div className="editor-tabbar">
      <div className="editor-tabbar__files" role="tablist" aria-label="Open files">
        {groups.flatMap((group) =>
          group.files.map((file) => (
            <div
              key={file.id}
              className={`editor-tab${!activePreview && selectedFileId === file.id ? ' is-active' : ''}`}
              onClick={() => onSelectFile(file.id)}
              onContextMenu={(event) => onTabContextMenu(event, file)}
              title={`${file.name} · ${file.connId ?? 'no connection'}/${file.database || '(connection level)'}`}
            >
              <SqlFileIcon />
              {renamingFileId === file.id ? (
                <input
                  ref={renameInputRef}
                  className="editor-tab__rename"
                  value={renameDraft}
                  aria-label={`Rename ${file.name}`}
                  onChange={(event) => onRenameDraftChange(event.target.value)}
                  onClick={(event) => event.stopPropagation()}
                  onBlur={onRenameCommit}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      onRenameCommit()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      onRenameCancel()
                    }
                  }}
                />
              ) : (
                file.name
              )}
              {dirtyIds.has(file.id) && (
                <span className="editor-tab__dot" title="Unsaved changes" />
              )}
              <button
                className="editor-tab__close"
                onClick={(e) => {
                  e.stopPropagation()
                  onCloseFile(file)
                }}
                title="Close tab"
                type="button"
              >
                <CloseIcon />
              </button>
            </div>
          ))
        )}
        {groups.flatMap((group) =>
          group.previews.map((tab) => (
            <div
              key={tab.id}
              className={`editor-tab${activePreview?.id === tab.id ? ' is-active' : ''}`}
              onClick={() => onSelectResultTab(tab.id)}
              title={`${tab.title} · ${tab.target.connName}/${tab.target.database}`}
              role="tab"
              aria-selected={activePreview?.id === tab.id}
            >
              <DatabaseIcon size={13} />
              {tab.title}
              {tab.running && <span className="spinner spinner--xs" />}
              <button
                className="editor-tab__close"
                onClick={(event) => {
                  event.stopPropagation()
                  onCloseResultTab(tab.id)
                }}
                title="Close data preview"
                type="button"
              >
                <CloseIcon />
              </button>
            </div>
          ))
        )}
        <button
          ref={newFileBtnRef}
          className="icon-btn icon-btn--sm editor-tabbar__new"
          title={!newFileDisabled ? 'New file' : 'Connect to a database to add a file'}
          aria-label="New file"
          aria-expanded={newFileMenuOpen}
          disabled={newFileDisabled}
          type="button"
          onClick={onToggleNewFileMenu}
        >
          <PlusThinIcon />
        </button>
      </div>
      {target && (
        <span
          className="ctx-chip ctx-chip--sm"
          title="Queries run against the app's active connection"
        >
          <span className="ctx-chip__lock">
            <LockIcon />
          </span>
          <span className="ctx-chip__dot" />
          <span className="ctx-chip__name">{target.connName}</span>
          <span className="ctx-chip__db">/ {target.database}</span>
        </span>
      )}
      {!activePreview && (
        <>
          {isSqlFile ? (
            <button
              className="btn-run btn-run--bar"
              type="button"
              disabled={!target}
              title={
                target
                  ? `Run statement at cursor (⌘⏎) — ${target.connName} / ${target.database}`
                  : 'Connect to a database to run queries'
              }
              onClick={onRun}
            >
              <PlayIcon />
              Run
              <span className="btn-run__kbd">⌘⏎</span>
            </button>
          ) : (
            <div className="editor-view-toggle" aria-label="File view">
              <button
                className={!isFilePreview ? 'is-active' : ''}
                type="button"
                aria-pressed={!isFilePreview}
                onClick={onExitFilePreview}
              >
                Edit
              </button>
              <button
                className={isFilePreview ? 'is-active' : ''}
                type="button"
                aria-pressed={isFilePreview}
                onClick={onEnterFilePreview}
              >
                <EyeIcon size={13} />
                Preview
              </button>
            </div>
          )}
          <button
            ref={actionsBtnRef}
            className={`btn-kebab${actionsOpen ? ' is-open' : ''}`}
            type="button"
            title="More actions"
            onClick={onToggleActions}
          >
            <KebabIcon />
          </button>
        </>
      )}
    </div>
  )
}

/** Right-click menu on a file tab. Mounted only while open. */
export function TabContextMenu({
  menu,
  onRename,
  onClose
}: {
  menu: TabMenu
  onRename: () => void
  onClose: () => void
}): ReactElement {
  useEscapeKey(true, onClose)

  return (
    <div
      className="ctx-overlay"
      onMouseDown={onClose}
      onContextMenu={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div
        className="ctx-menu"
        role="menu"
        style={{ left: menu.x, top: menu.y }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="ctx-menu__item" type="button" role="menuitem" onClick={onRename}>
          Rename…
        </button>
      </div>
    </div>
  )
}

/** "New file" type picker dropped below the tab strip's + button. */
export function NewFileMenu({
  anchor,
  onCreate,
  onClose
}: {
  anchor: HTMLButtonElement
  onCreate: (kind: FileKind) => void
  onClose: () => void
}): ReactElement {
  useEscapeKey(true, onClose)

  return (
    <>
      <div className="ctx-overlay" onClick={onClose} />
      <div
        className="ctx-menu new-file-menu"
        style={menuPosition(anchor)}
        role="menu"
        aria-label="New file type"
      >
        {(
          [
            ['sql', 'SQL file', '.sql'],
            ['markdown', 'Markdown file', '.md'],
            ['json', 'JSON file', '.json'],
            ['text', 'Text file', '.txt']
          ] as const
        ).map(([kind, label, extension]) => (
          <button
            key={kind}
            className="ctx-menu__item new-file-menu__item"
            type="button"
            role="menuitem"
            onClick={() => onCreate(kind)}
          >
            <SqlFileIcon size={13} />
            <span>{label}</span>
            <span className="new-file-menu__extension">{extension}</span>
          </button>
        ))}
      </div>
    </>
  )
}

/** The kebab dropdown: format, save, save-as-exemplar. */
export function ActionsMenu({
  anchor,
  isSqlFile,
  saveDisabled,
  hasTarget,
  onSave,
  onExemplar,
  onClose
}: {
  anchor: HTMLButtonElement
  isSqlFile: boolean
  saveDisabled: boolean
  hasTarget: boolean
  onSave: () => void
  onExemplar: () => void
  onClose: () => void
}): ReactElement {
  useEscapeKey(true, onClose)

  return (
    <>
      <div className="ctx-overlay" onClick={onClose} />
      <div className="ctx-menu toolbar-menu" style={menuPosition(anchor)} role="menu">
        {isSqlFile && (
          <button className="toolbar-menu__item" type="button" role="menuitem" onClick={onClose}>
            <FormatIcon />
            <span>Format SQL</span>
            <span className="toolbar-menu__kbd">⇧⌘F</span>
          </button>
        )}
        <button
          className="toolbar-menu__item"
          type="button"
          role="menuitem"
          disabled={saveDisabled}
          onClick={() => {
            onSave()
            onClose()
          }}
        >
          <SaveIcon />
          <span>Save file</span>
          <span className="toolbar-menu__kbd">⌘S</span>
        </button>
        {isSqlFile && (
          <button
            className="toolbar-menu__item"
            type="button"
            role="menuitem"
            disabled={!hasTarget}
            title={
              hasTarget
                ? 'Save the current query as a reusable exemplar'
                : 'Connect to a database to save an exemplar'
            }
            onClick={() => {
              onClose()
              onExemplar()
            }}
          >
            <SparkleIcon />
            <span>Save as exemplar…</span>
          </button>
        )}
      </div>
    </>
  )
}
