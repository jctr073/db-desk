import type { ReactElement } from 'react'

import type { FileState, QueryFile } from '../files/useFileState'
import { SqlFileIcon, CloseIcon } from './icons'

interface FilesPanelProps {
  files: FileState
  /** Connection id → display name. */
  connNames: Record<string, string>
  /** When set, only files on this connection are listed — the panel follows the app's active connection. */
  activeConnId?: string | null
}

function groupLabel(
  file: QueryFile,
  connNames: Record<string, string>
): string {
  if (!file.connId) return 'No connection'
  const name = connNames[file.connId] ?? file.connId
  return file.database ? `${name} / ${file.database}` : name
}

export function FilesPanel({
  files,
  connNames,
  activeConnId
}: FilesPanelProps): ReactElement {
  const visibleFiles =
    activeConnId != null
      ? files.files.filter((file) => file.connId === activeConnId)
      : files.files
  const hiddenCount = files.files.length - visibleFiles.length

  const groups = new Map<string, QueryFile[]>()
  for (const file of visibleFiles) {
    const label = groupLabel(file, connNames)
    const list = groups.get(label) ?? []
    list.push(file)
    groups.set(label, list)
  }

  if (files.files.length === 0) {
    return (
      <div className="files-panel-empty">
        <div className="files-panel-empty__text">No query files yet</div>
        <div className="files-panel-empty__hint">
          Use the + button in the editor tab bar, or right-click a connection
        </div>
      </div>
    )
  }

  if (visibleFiles.length === 0) {
    return (
      <div className="files-panel-empty">
        <div className="files-panel-empty__text">
          No query files on this connection yet
        </div>
        <div className="files-panel-empty__hint">
          Use the + button in the editor tab bar, or right-click a connection
        </div>
      </div>
    )
  }

  return (
    <div className="files-panel">
      {[...groups.entries()].map(([label, groupFiles]) => (
        <div key={label} className="files-panel-group">
          <div className="files-panel-group__header" title={label}>
            {label}
          </div>
          {groupFiles.map((file) => (
            <div
              key={file.id}
              className={`files-panel-item${files.selectedFileId === file.id ? ' is-active' : ''}`}
              onClick={() => files.selectFile(file.id)}
            >
              <SqlFileIcon />
              <span className="files-panel-item__name">{file.name}</span>
              <button
                className="files-panel-item__close"
                onClick={(e) => {
                  e.stopPropagation()
                  files.deleteFile(file.id)
                }}
                type="button"
                title="Delete file"
              >
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>
      ))}
      {hiddenCount > 0 && (
        <div className="files-panel-empty__hint" style={{ padding: '8px 12px' }}>
          {hiddenCount} file{hiddenCount === 1 ? '' : 's'} on other connections
        </div>
      )}
    </div>
  )
}
