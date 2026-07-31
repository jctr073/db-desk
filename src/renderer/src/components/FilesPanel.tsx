import { useState } from 'react'
import type { ReactElement } from 'react'

import type { ExternalFile } from '../../../shared/files'
import type { FileState, QueryFile } from '../files/useFileState'
import type { WatchedFilesState } from '../files/useWatchedFiles'
import { SqlFileIcon, CloseIcon } from './icons'

interface FilesPanelProps {
  files: FileState
  /** Watched-folder listing + open state, for the Folders mode. */
  watched: WatchedFilesState
  /** Connection id → display name. */
  connNames: Record<string, string>
  /** When set, only files on this connection are listed — the panel follows the app's active connection. */
  activeConnId?: string | null
}

type PanelMode = 'connection' | 'folders'

function groupLabel(file: QueryFile, connNames: Record<string, string>): string {
  if (!file.connId) return 'No connection'
  const name = connNames[file.connId] ?? file.connId
  return file.database ? `${name} / ${file.database}` : name
}

function ConnectionFiles({
  files,
  connNames,
  activeConnId
}: Omit<FilesPanelProps, 'watched'>): ReactElement {
  const visibleFiles =
    activeConnId != null ? files.files.filter((file) => file.connId === activeConnId) : files.files
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
        <div className="files-panel-empty__text">No files yet</div>
        <div className="files-panel-empty__hint">
          Use the + button in the editor tab bar, or right-click a connection
        </div>
      </div>
    )
  }

  if (visibleFiles.length === 0) {
    return (
      <div className="files-panel-empty">
        <div className="files-panel-empty__text">No files on this connection yet</div>
        <div className="files-panel-empty__hint">
          Use the + button in the editor tab bar, or right-click a connection
        </div>
      </div>
    )
  }

  return (
    <>
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
    </>
  )
}

function FolderFiles({ watched }: { watched: WatchedFilesState }): ReactElement {
  if (watched.folders.length === 0) {
    return (
      <div className="files-panel-empty">
        <div className="files-panel-empty__text">No watched folders yet</div>
        <div className="files-panel-empty__hint">
          Add folders in Settings → Files to make their SQL, CSV, and other supported files
          available to any connection
        </div>
      </div>
    )
  }

  const byFolder = new Map<string, ExternalFile[]>()
  for (const file of watched.files) {
    const list = byFolder.get(file.folderId) ?? []
    list.push(file)
    byFolder.set(file.folderId, list)
  }

  return (
    <>
      {watched.folders.map((folder) => {
        const folderFiles = byFolder.get(folder.id) ?? []
        return (
          <div key={folder.id} className="files-panel-group">
            <div className="files-panel-group__header" title={folder.path}>
              {folder.label}
            </div>
            {folderFiles.length === 0 && (
              <div className="files-panel-empty__hint" style={{ padding: '4px 12px 8px' }}>
                No supported files
              </div>
            )}
            {folderFiles.map((file) => (
              <div
                key={file.path}
                className={`files-panel-item${watched.selectedPath === file.path ? ' is-active' : ''}`}
                title={file.path}
                onClick={() => watched.openFile(file.path)}
              >
                <SqlFileIcon />
                <span className="files-panel-item__name">{file.name}</span>
              </div>
            ))}
          </div>
        )
      })}
    </>
  )
}

export function FilesPanel({
  files,
  watched,
  connNames,
  activeConnId
}: FilesPanelProps): ReactElement {
  const [mode, setMode] = useState<PanelMode>('connection')

  return (
    <div className="files-panel">
      <div className="files-panel__modes" role="tablist" aria-label="File list mode">
        {(
          [
            ['connection', 'By connection'],
            ['folders', 'Folders']
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            className={`files-panel__mode${mode === value ? ' is-active' : ''}`}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === 'connection' ? (
        <ConnectionFiles files={files} connNames={connNames} activeConnId={activeConnId} />
      ) : (
        <FolderFiles watched={watched} />
      )}
    </div>
  )
}
