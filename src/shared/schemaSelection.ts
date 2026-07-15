/**
 * Schema/catalog pinning for multi-database engines (Databricks). A saved
 * selection limits which catalogs appear in the tree and which schemas of a
 * catalog are introspected — sidebar, agent schema summary, and the agent's
 * search/describe tools all see only the pinned set. No selection means
 * everything loads, except that an unpinned catalog with more schemas than
 * the threshold below prompts for a selection instead of introspecting.
 */

/**
 * Above this many schemas, an unpinned Databricks catalog is not
 * introspected; the UI opens the schema picker first.
 */
export const LARGE_CATALOG_SCHEMA_THRESHOLD = 25

/** Per-connection selection config as it travels to the renderer. */
export interface SchemaSelectionConfig {
  /** Catalogs to show in the tree; null = all. */
  catalogs: string[] | null
  /** Catalog name → pinned schema names; missing key = all schemas. */
  schemas: Record<string, string[]>
}
