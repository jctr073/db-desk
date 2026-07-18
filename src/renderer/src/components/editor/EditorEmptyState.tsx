import { useMemo } from 'react'
import type { ReactElement } from 'react'

import type { FileState } from '../../files/useFileState'
import { PlusThinIcon, SqlDocIcon, SqlFileIcon } from '../icons'
import type { QueryTarget } from '../useQueryRunner'

interface EditorEmptyStateProps {
  target: QueryTarget | null
  /** Connection id → display name, to label where a saved file lives. */
  connNames: Record<string, string>
  files: FileState
  onOpenFile: (id: string) => void
}

/** Nothing open: the default screen instead of a blank Monaco surface. */
export function EditorEmptyState({
  target,
  connNames,
  files,
  onOpenFile
}: EditorEmptyStateProps): ReactElement {
  // Only rendered when no group is open, so every open id is already gone.
  const closedFiles = useMemo(
    () => files.files.filter((f) => !files.openFileIds.has(f.id)),
    [files.files, files.openFileIds]
  )

  return (
    <div className="editor-empty">
      <div className="empty-state">
        <div className="empty-state__icon">
          <SqlDocIcon size={34} />
        </div>
        <div className="empty-state__title">No file open</div>
        <div className="empty-state__text">
          {target
            ? `Start a new query against ${target.connName} / ${target.database}, or reopen a saved one.`
            : 'Connect to a PostgreSQL database, then open a query to start writing SQL.'}
        </div>
        <button
          className="btn-primary"
          type="button"
          disabled={!target}
          title={target ? undefined : 'Connect to a database to add a query'}
          onClick={() => {
            if (!target) return
            files.createFile(target.connId, target.database)
          }}
        >
          <PlusThinIcon />
          New Query
        </button>
        {closedFiles.length > 0 && (
          <div className="editor-empty__recent">
            <div className="editor-empty__recent-title">Saved files</div>
            {closedFiles.map((file) => {
              // Names are only unique per (connection, database), so
              // the origin is what disambiguates rows here.
              const origin = file.connId
                ? `${connNames[file.connId] ?? file.connId}${
                    file.database ? ` / ${file.database}` : ''
                  }`
                : ''
              return (
                <button
                  key={file.id}
                  className="editor-empty__file"
                  type="button"
                  title={`Open ${file.name} — ${origin}`}
                  onClick={() => onOpenFile(file.id)}
                >
                  <SqlFileIcon size={13} />
                  <span className="editor-empty__file-name">{file.name}</span>
                  <span className="editor-empty__file-origin">{origin}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
