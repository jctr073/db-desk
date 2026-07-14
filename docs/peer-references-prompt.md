# Prompt: Peer references in the References popover

Extend the references feature so the ReferencesPopover shows **peer columns** in
addition to the existing "References" (outbound) and "Referenced by" (inbound)
sections. A peer is another table carrying the same column — e.g. selecting
`orders.contract_id` should also surface every other table that has
`contract_id`.

Postgres only, consistent with how the rest of the reference feature is gated.

## Where the code lives

- `src/renderer/src/connections/references.ts` — pure reference-graph module
  over cached introspection: `buildReferenceIndex` produces FK + logical-FK
  (LFK) edges; `columnReferences` / `tableReferences` filter them per subject.
  New peer logic belongs here as pure functions so it stays unit-testable.
- `src/renderer/src/connections/ReferencesPopover.tsx` — the anchored popover
  that renders the sections. Add the peer section(s) here.
- Existing tests for the reference module live alongside it in `test/` /
  vitest; follow the same pattern for peer functions.

## Two flavors of peers — implement both, with precedence

**1. Semantic peers (primary).** When the subject column has a resolved target
(FK or LFK), peers are the *other* source columns whose edges point at the
same target. Derive this entirely from the existing edge list: take the
subject's outbound edge(s), collect inbound edges of each target, exclude the
subject itself. No new inference; every peer is grounded in a declared or
inferred FK, so noise is inherently low.

**2. Name-based peers (fallback only).** When the subject column resolves to
no target anywhere (e.g. `tenant_id` with no `tenants` table, `country_code`,
`external_ref`), fall back to matching other columns by lowercase name plus
the same `typeFamily`. Guard against generic names with both:

- a small stoplist of universal column names (`id`, `name`, `created_at`,
  `updated_at`, `status`, `type`, `description`, …), and
- a prevalence cutoff: skip name-peering when the column name appears in more
  than ~30% of relations in the database (a self-tuning version of the
  stoplist).

Only show name-based peers when semantic peers are empty, so the two flavors
never double-report the same tables.

## UI

- Add a third section to `ReferencesPopover` beneath "References" and
  "Referenced by". Heading like "Also references <schema.table>" for semantic
  peers, or "Also has <column>" for name-based peers.
- Rows navigate to the peer column in the connections tree via the existing
  `onNavigate(endpoint)` callback, and carry a badge distinguishing peer kind
  (reuse the FK/LFK badge treatment; name-based peers get their own subtle
  badge).
- Peers can be a long list (a hot column may live in 25+ tables): cap the
  section at ~8 rows with a "show all N" expander instead of overflowing
  `POP_MAX_HEIGHT`.
- Peers apply to **column** subjects. For table subjects, skip the section
  (or revisit later).

## Fast follow (separate change, same feature area)

Add an "insert join" / copy-to-clipboard affordance on reference rows: every
edge is a complete join predicate, so a row can emit
`JOIN contracts ON contracts.id = orders.contract_id` into the SQL editor.

## Deferred ideas (do not build now, kept for context)

- Follow references from the results grid (row-level FK navigation from a
  cell value in `ResultsPanel.tsx`).
- Join-path discovery between two tables; feeding FK/LFK edges into the agent
  panel's schema context as join hints.
- LFK integrity check ("check for orphans" via LEFT JOIN).
- Local one-hop ER diagram of a table's neighborhood.

## Acceptance

- Pure peer functions in `references.ts` with unit tests covering: semantic
  peers found via shared target, self excluded, name-based fallback fires only
  with no target, stoplist and prevalence cutoff suppress generic columns,
  type-family mismatch excluded.
- Popover renders the new section, navigates on click, and caps long lists.
- `npm test` and lint/typecheck pass.
