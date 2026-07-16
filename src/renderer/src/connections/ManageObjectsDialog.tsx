import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import {
  LARGE_CATALOG_SCHEMA_THRESHOLD,
  type SchemaSelectionConfig
} from '../../../shared/schemaSelection'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  DatabaseIcon,
  SearchIcon
} from '../components/icons'

interface ManageObjectsDialogProps {
  subtitle: string
  /** Full catalog list; null while it loads. */
  catalogs: string[] | null
  /** Saved catalog and per-catalog schema selections. */
  initialConfig: SchemaSelectionConfig | null
  /** Catalog name -> full schema list. Missing entries have not loaded yet. */
  schemaLists: Record<string, string[] | undefined>
  schemaErrors: Record<string, string | undefined>
  /** Catalog to reveal immediately (used by the large-catalog prompt). */
  initialExpanded?: string
  error?: string
  onLoadSchemas: (catalog: string) => void
  onSubmit: (config: SchemaSelectionConfig) => Promise<void>
  onClose: () => void
}

function HierarchyCheckbox({
  checked,
  indeterminate,
  disabled,
  label,
  onChange
}: {
  checked: boolean
  indeterminate?: boolean
  disabled?: boolean
  label: string
  onChange: () => void
}): ReactElement {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate
  }, [indeterminate])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onChange={onChange}
    />
  )
}

/**
 * Hierarchical Databricks picker. A catalog can be disabled as a unit, left
 * fully enabled, or kept enabled with only a subset of its schemas.
 */
export function ManageObjectsDialog({
  subtitle,
  catalogs,
  initialConfig,
  schemaLists,
  schemaErrors,
  initialExpanded,
  error,
  onLoadSchemas,
  onSubmit,
  onClose
}: ManageObjectsDialogProps): ReactElement {
  const [enabledCatalogs, setEnabledCatalogs] = useState<Set<string>>(new Set())
  const [schemaSelections, setSchemaSelections] = useState<
    Record<string, string[] | null>
  >({})
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(initialExpanded ? [initialExpanded] : [])
  )
  const [filter, setFilter] = useState('')
  const [saving, setSaving] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    if (!catalogs || !initialConfig) return
    const enabled = initialConfig.catalogs
      ? catalogs.filter((catalog) => initialConfig.catalogs!.includes(catalog))
      : catalogs
    setEnabledCatalogs(new Set(enabled))
    setSchemaSelections(
      Object.fromEntries(
        catalogs.map((catalog) => [
          catalog,
          initialConfig.schemas[catalog]
            ? [...initialConfig.schemas[catalog]]
            : null
        ])
      )
    )
  }, [catalogs, initialConfig])

  useEffect(() => {
    if (initialExpanded) onLoadSchemas(initialExpanded)
  }, [initialExpanded, onLoadSchemas])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const visibleCatalogs = useMemo(() => {
    if (!catalogs) return []
    const needle = filter.trim().toLowerCase()
    if (!needle) return catalogs
    return catalogs.filter(
      (catalog) =>
        catalog.toLowerCase().includes(needle) ||
        schemaLists[catalog]?.some((schema) =>
          schema.toLowerCase().includes(needle)
        )
    )
  }, [catalogs, filter, schemaLists])

  const toggleExpanded = (catalog: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(catalog)) next.delete(catalog)
      else {
        next.add(catalog)
        onLoadSchemas(catalog)
      }
      return next
    })
  }

  const toggleCatalog = (catalog: string): void => {
    setEnabledCatalogs((previous) => {
      const next = new Set(previous)
      if (next.has(catalog)) next.delete(catalog)
      else next.add(catalog)
      return next
    })
    if (
      !enabledCatalogs.has(catalog) &&
      schemaSelections[catalog]?.length === 0
    ) {
      setSchemaSelections((previous) => ({ ...previous, [catalog]: null }))
    }
  }

  const toggleSchema = (catalog: string, schema: string): void => {
    const schemas = schemaLists[catalog]
    if (!schemas) return
    const current = schemaSelections[catalog]
    const next = new Set(current ?? schemas)
    if (next.has(schema)) next.delete(schema)
    else next.add(schema)
    const ordered = schemas.filter((candidate) => next.has(candidate))
    setSchemaSelections((previous) => ({
      ...previous,
      [catalog]: ordered.length === schemas.length ? null : ordered
    }))
    setEnabledCatalogs((previous) => {
      const updated = new Set(previous)
      if (ordered.length === 0 && schemas.length > 0) updated.delete(catalog)
      else updated.add(catalog)
      return updated
    })
  }

  const setVisible = (enabled: boolean): void => {
    setEnabledCatalogs((previous) => {
      const next = new Set(previous)
      for (const catalog of visibleCatalogs) {
        if (enabled) next.add(catalog)
        else next.delete(catalog)
      }
      return next
    })
    if (enabled) {
      setSchemaSelections((previous) => {
        const next = { ...previous }
        for (const catalog of visibleCatalogs) next[catalog] = null
        return next
      })
    }
  }

  const submit = async (): Promise<void> => {
    if (saving || !catalogs || !initialConfig) return
    setSubmitError(null)
    setSaving(true)
    try {
      const selectedCatalogs = catalogs.filter((catalog) =>
        enabledCatalogs.has(catalog)
      )
      const schemas: Record<string, string[]> = {}
      for (const catalog of catalogs) {
        const selected = schemaSelections[catalog]
        const available = schemaLists[catalog]
        if (selected == null) {
          // An explicit full list tells the introspector that the user chose
          // to load a large catalog, instead of immediately prompting again.
          if (
            available &&
            available.length > LARGE_CATALOG_SCHEMA_THRESHOLD &&
            enabledCatalogs.has(catalog)
          ) {
            schemas[catalog] = [...available]
          }
          continue
        }
        const ordered = available
          ? available.filter((schema) => selected.includes(schema))
          : selected
        if (!available || ordered.length < available.length) {
          schemas[catalog] = ordered
        }
      }
      await onSubmit({
        catalogs:
          selectedCatalogs.length === catalogs.length ? null : selectedCatalogs,
        schemas
      })
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : String(cause))
      setSaving(false)
    }
  }

  const needle = filter.trim().toLowerCase()

  return (
    <div className="dialog-overlay">
      <div
        className="dialog manage-objects-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Manage Catalogs and Schemas"
      >
        <div className="dialog__header">
          <span className="dialog__icon">
            <DatabaseIcon size={16} />
          </span>
          <div className="dialog__titles">
            <div className="dialog__title">Manage Catalogs and Schemas</div>
            <div className="dialog__subtitle">{subtitle}</div>
          </div>
          <button
            className="dialog__close"
            onClick={onClose}
            title="Close"
            type="button"
            disabled={saving}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="dialog__body manage-objects-dialog__body">
          <div className="manage-objects-toolbar">
            <div className="filter-box manage-objects-filter">
              <SearchIcon />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter catalogs and schemas…"
                aria-label="Filter catalogs and schemas"
                autoFocus
              />
            </div>
            <button
              type="button"
              className="manage-objects-link"
              onClick={() => setVisible(true)}
            >
              Select all
            </button>
            <button
              type="button"
              className="manage-objects-link"
              onClick={() => setVisible(false)}
            >
              Select none
            </button>
          </div>

          {error ? (
            <div className="mcp-form-error">{error}</div>
          ) : (
            <div className="manage-objects-tree" role="tree">
              {!catalogs && (
                <div className="manage-objects-empty">Loading catalogs…</div>
              )}
              {catalogs && catalogs.length === 0 && (
                <div className="manage-objects-empty">No catalogs found.</div>
              )}
              {catalogs &&
                catalogs.length > 0 &&
                visibleCatalogs.length === 0 && (
                  <div className="manage-objects-empty">
                    No catalogs or loaded schemas match the filter.
                  </div>
                )}
              {visibleCatalogs.map((catalog) => {
                const schemas = schemaLists[catalog]
                const selected = schemaSelections[catalog]
                const enabled = enabledCatalogs.has(catalog)
                const catalogMatches = catalog.toLowerCase().includes(needle)
                const schemaMatches =
                  !!needle &&
                  !!schemas?.some((schema) =>
                    schema.toLowerCase().includes(needle)
                  )
                const isExpanded = expanded.has(catalog) || schemaMatches
                const visibleSchemas = schemas?.filter(
                  (schema) =>
                    !needle ||
                    catalogMatches ||
                    schema.toLowerCase().includes(needle)
                )
                const selectedCount = selected
                  ? schemas
                    ? schemas.filter((schema) => selected.includes(schema))
                        .length
                    : selected.length
                  : schemas?.length
                const partial =
                  enabled &&
                  selected !== null &&
                  (!schemas || selectedCount !== schemas.length)
                return (
                  <div
                    key={catalog}
                    className="manage-objects-catalog"
                    role="treeitem"
                    aria-expanded={isExpanded}
                  >
                    <div
                      className={`manage-objects-row manage-objects-row--catalog${enabled ? '' : ' is-disabled'}`}
                    >
                      <button
                        type="button"
                        className="manage-objects-chevron"
                        onClick={() => toggleExpanded(catalog)}
                        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${catalog}`}
                      >
                        {isExpanded ? (
                          <ChevronDownIcon size={13} />
                        ) : (
                          <ChevronRightIcon size={10} />
                        )}
                      </button>
                      <HierarchyCheckbox
                        checked={enabled && !partial}
                        indeterminate={partial}
                        label={`${enabled ? 'Disable' : 'Enable'} catalog ${catalog}`}
                        onChange={() => toggleCatalog(catalog)}
                      />
                      <button
                        type="button"
                        className="manage-objects-name"
                        onClick={() => toggleExpanded(catalog)}
                      >
                        {catalog}
                      </button>
                      <span className="manage-objects-count">
                        {!enabled
                          ? 'Off'
                          : selected === null || selectedCount === schemas?.length
                            ? 'All schemas'
                            : schemas
                              ? `${selectedCount} of ${schemas.length}`
                              : `${selected.length} selected`}
                      </span>
                    </div>
                    {isExpanded && (
                      <div role="group" className="manage-objects-schemas">
                        {!schemas && !schemaErrors[catalog] && (
                          <div className="manage-objects-child-status">
                            Loading schemas…
                          </div>
                        )}
                        {schemaErrors[catalog] && (
                          <div className="manage-objects-child-error">
                            {schemaErrors[catalog]}
                          </div>
                        )}
                        {schemas && schemas.length === 0 && (
                          <div className="manage-objects-child-status">
                            No schemas found.
                          </div>
                        )}
                        {visibleSchemas?.map((schema) => {
                          const checked =
                            enabled &&
                            (selected === null || selected.includes(schema))
                          return (
                            <label
                              key={schema}
                              className={`manage-objects-row manage-objects-row--schema${enabled ? '' : ' is-disabled'}`}
                            >
                              <span
                                className="manage-objects-branch"
                                aria-hidden="true"
                              />
                              <HierarchyCheckbox
                                checked={checked}
                                disabled={!enabled}
                                label={`${checked ? 'Disable' : 'Enable'} schema ${schema}`}
                                onChange={() => toggleSchema(catalog, schema)}
                              />
                              <span className="manage-objects-schema-name">
                                {schema}
                              </span>
                            </label>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {submitError && <div className="mcp-form-error">{submitError}</div>}
        </div>

        <div className="dialog__footer">
          <div className="test-msg">
            {catalogs
              ? `${enabledCatalogs.size} of ${catalogs.length} catalogs enabled`
              : ''}
          </div>
          <button
            className="btn-cancel"
            onClick={onClose}
            type="button"
            disabled={saving}
          >
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => void submit()}
            disabled={saving || !catalogs || !initialConfig || !!error}
            type="button"
          >
            {saving && <span className="spinner" />}
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
