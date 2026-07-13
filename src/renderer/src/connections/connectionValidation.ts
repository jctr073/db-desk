/**
 * Connection-dialog field validation. Split out from NewConnectionDialog so
 * the rule (and its interaction with URL parsing) can be unit tested without
 * rendering the dialog.
 */

import { parseConnectionUrl } from '../../../shared/connectionUrl'
import type { DialectInfo } from '../../../shared/dialect'

/**
 * Inline error for the database/catalog field, or null when the form is
 * valid. Only dialects pinned to a single database at connect time
 * (`multiDatabase === false`, i.e. PostgreSQL) require a value — Databricks
 * catalogs stay optional since one connection can browse every catalog.
 */
export function databaseFieldError(
  dialect: DialectInfo,
  isParams: boolean,
  database: string,
  url: string
): string | null {
  if (dialect.multiDatabase) return null

  if (isParams) {
    return database.trim()
      ? null
      : `${dialect.form.databaseLabel} is required.`
  }

  // Only flag a URL that parses but omits the database segment; a malformed
  // or empty URL is left to the existing test/connect-time error instead.
  const parsed = parseConnectionUrl(url)
  if (!parsed) return null
  return parsed.database.trim()
    ? null
    : `Connection URL must include a ${dialect.databaseTerm} (e.g. ${dialect.urlExample}).`
}
