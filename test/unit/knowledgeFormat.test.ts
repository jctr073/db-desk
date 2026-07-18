/**
 * Unit tests for the knowledge panel's pure display helpers in
 * src/renderer/src/knowledge/format.ts: ref parsing/formatting, record
 * titles, search text, dangling-ref detection, usage-hit summaries (incl.
 * the polymorphic join phrasing), and ref suggestions.
 */

import { describe, expect, it } from 'vitest'

import type { DatabaseIntrospection } from '../../src/shared/db'
import type {
  ColumnRef,
  ExemplarRecord,
  GlossaryRecord,
  KnowledgeRecord,
  NoteRecord,
  RelationshipRecord
} from '../../src/shared/knowledge'
import { tableNameAliases } from '../../src/shared/knowledge'
import {
  buildRefKeySet,
  danglingRefs,
  formatRef,
  isKnownKind,
  parseRefText,
  recordRefs,
  recordSearchText,
  recordTitle,
  refSuggestions,
  summarizeUsage
} from '../../src/renderer/src/knowledge/format'

const col = (schema: string, table: string, column?: string): ColumnRef => ({
  schema,
  table,
  column
})

const envelope = { source: 'human' as const, createdAt: 1, updatedAt: 2 }

const polymorphic: RelationshipRecord = {
  ...envelope,
  id: 'kn-p',
  kind: 'relationship',
  relType: 'polymorphic',
  from: col('public', 'events', 'subject_id'),
  discriminator: col('public', 'events', 'subject_type'),
  targets: {
    patient: col('public', 'patients', 'id'),
    provider: col('public', 'providers', 'id')
  }
}

const glossary: GlossaryRecord = {
  ...envelope,
  id: 'kn-g',
  kind: 'glossary',
  term: 'Net revenue',
  synonyms: ['revenue', 'sales'],
  definition: 'Gross minus refunds',
  mappings: [{ ref: col('public', 'orders', 'total'), caveat: 'excludes tax' }]
}

const note: NoteRecord = {
  ...envelope,
  id: 'kn-n',
  kind: 'note',
  title: 'Soft deletes',
  body: 'Rows are never deleted',
  references: [col('public', 'users', 'deleted_at')]
}

const exemplar: ExemplarRecord = {
  ...envelope,
  id: 'kn-e',
  kind: 'exemplar',
  question: 'How many active users?',
  sql: 'SELECT count(*) FROM users WHERE deleted_at IS NULL',
  references: [col('public', 'users', 'deleted_at')]
}

describe('parseRefText / formatRef', () => {
  it('round-trips column and table refs', () => {
    expect(parseRefText('public.users.email')).toEqual(col('public', 'users', 'email'))
    expect(parseRefText('public.users')).toEqual({ schema: 'public', table: 'users' })
    expect(formatRef(col('public', 'users', 'email'))).toBe('public.users.email')
    expect(formatRef({ schema: 'public', table: 'users' })).toBe('public.users')
  })

  it('trims whitespace and rejects malformed text', () => {
    expect(parseRefText('  public.users.email  ')).toEqual(col('public', 'users', 'email'))
    expect(parseRefText('users')).toBeNull()
    expect(parseRefText('a.b.c.d')).toBeNull()
    expect(parseRefText('public..email')).toBeNull()
    expect(parseRefText('')).toBeNull()
  })
})

describe('recordTitle', () => {
  it('summarizes each kind on one line', () => {
    expect(
      recordTitle({
        ...envelope,
        id: 'kn-a',
        kind: 'annotation',
        target: col('public', 'users', 'email'),
        text: 'PII — mask in exports'
      })
    ).toBe('public.users.email — PII — mask in exports')
    expect(recordTitle(polymorphic)).toBe('public.events.subject_id → 2 polymorphic targets')
    expect(
      recordTitle({
        ...envelope,
        id: 'kn-r',
        kind: 'relationship',
        relType: 'standard',
        from: col('public', 'orders', 'user_id'),
        to: col('public', 'users', 'id')
      })
    ).toBe('public.orders.user_id → public.users.id')
    expect(recordTitle(glossary)).toBe('Net revenue')
    expect(recordTitle(note)).toBe('Soft deletes')
    expect(recordTitle(exemplar)).toBe('How many active users?')
  })

  it('does not crash on an unknown forward-compat kind', () => {
    const weird = { ...envelope, id: 'kn-x', kind: 'metric' } as unknown as KnowledgeRecord
    expect(recordTitle(weird)).toBe('metric')
    expect(isKnownKind('metric')).toBe(false)
    expect(isKnownKind('glossary')).toBe(true)
  })
})

describe('recordSearchText', () => {
  it('covers terms, synonyms, refs, and free text, lowercased', () => {
    const haystack = recordSearchText(glossary)
    expect(haystack).toContain('net revenue')
    expect(haystack).toContain('sales')
    expect(haystack).toContain('public.orders.total')
    expect(haystack).toContain('excludes tax')
  })

  it('includes polymorphic discriminator values and targets', () => {
    const haystack = recordSearchText(polymorphic)
    expect(haystack).toContain('patient')
    expect(haystack).toContain('public.providers.id')
  })
})

describe('recordRefs / danglingRefs / buildRefKeySet', () => {
  const intro: DatabaseIntrospection = {
    name: 'app',
    schemas: [
      {
        name: 'public',
        tables: [
          {
            name: 'users',
            columns: [
              { name: 'id', dataType: 'int', badge: 'pk' },
              { name: 'email', dataType: 'text', badge: null }
            ]
          }
        ],
        views: [],
        matviews: [],
        indexes: [],
        functions: [],
        sequences: [],
        types: [],
        aggregates: []
      }
    ]
  }

  it('collects every structured ref of a relationship', () => {
    expect(recordRefs(polymorphic)).toEqual([
      col('public', 'events', 'subject_id'),
      col('public', 'events', 'subject_type'),
      col('public', 'patients', 'id'),
      col('public', 'providers', 'id')
    ])
  })

  it('builds table and column keys from the introspection', () => {
    const keys = buildRefKeySet(intro)
    expect(keys.has('public.users')).toBe(true)
    expect(keys.has('public.users.email')).toBe(true)
    expect(keys.has('public.users.missing')).toBe(false)
  })

  it('flags only refs missing from the schema, case-insensitively', () => {
    const keys = buildRefKeySet(intro)
    const record: NoteRecord = {
      ...note,
      references: [col('PUBLIC', 'Users', 'Email'), col('public', 'ghosts', 'id')]
    }
    expect(danglingRefs(record, keys)).toEqual([col('public', 'ghosts', 'id')])
  })

  it('resolves schema-prefixed refs against unprefixed tables (Databricks-form ref, Postgres schema)', () => {
    const keys = buildRefKeySet(intro)
    const record: NoteRecord = {
      ...note,
      references: [
        col('public', 'public_users'),
        col('public', 'public_users', 'email'),
        col('public', 'public_users', 'missing')
      ]
    }
    expect(danglingRefs(record, keys)).toEqual([col('public', 'public_users', 'missing')])
  })

  it('resolves unprefixed refs against schema-prefixed tables (Postgres-form ref, Databricks schema)', () => {
    const databricks: DatabaseIntrospection = {
      name: 'warehouse',
      schemas: [
        {
          ...intro.schemas[0],
          name: 'billing',
          tables: [
            {
              name: 'billing_subscriptions',
              columns: [{ name: 'contract_id', dataType: 'string', badge: null }]
            }
          ]
        }
      ]
    }
    const keys = buildRefKeySet(databricks)
    const record: NoteRecord = {
      ...note,
      references: [
        col('billing', 'subscriptions', 'contract_id'),
        col('billing', 'billing_subscriptions', 'contract_id'),
        col('billing', 'invoices', 'id')
      ]
    }
    expect(danglingRefs(record, keys)).toEqual([col('billing', 'invoices', 'id')])
  })
})

describe('tableNameAliases', () => {
  it('always offers the schema-prefixed form', () => {
    expect(tableNameAliases('billing', 'subscriptions')).toEqual(['billing_subscriptions'])
  })

  it('offers the stripped form when the table already carries the prefix', () => {
    expect(tableNameAliases('billing', 'billing_subscriptions')).toEqual([
      'billing_billing_subscriptions',
      'subscriptions'
    ])
  })

  it('matches the prefix case-insensitively but never strips to an empty name', () => {
    expect(tableNameAliases('Billing', 'BILLING_invoices')).toContain('invoices')
    expect(tableNameAliases('billing', 'billing_')).toEqual(['billing_billing_'])
  })
})

describe('summarizeUsage', () => {
  it('describes a polymorphic join target with its discriminator values', () => {
    const summary = summarizeUsage(
      { recordId: 'kn-p', kind: 'relationship', role: 'joins-to' },
      polymorphic,
      col('public', 'patients', 'id')
    )
    expect(summary).toBe(
      "Polymorphic join target of public.events.subject_id when public.events.subject_type = 'patient'"
    )
  })

  it('describes the discriminator and standard join roles', () => {
    expect(
      summarizeUsage(
        { recordId: 'kn-p', kind: 'relationship', role: 'discriminator' },
        polymorphic,
        col('public', 'events', 'subject_type')
      )
    ).toBe('Discriminator for the polymorphic join from public.events.subject_id')
    const standard: RelationshipRecord = {
      ...envelope,
      id: 'kn-r',
      kind: 'relationship',
      relType: 'standard',
      from: col('public', 'orders', 'user_id'),
      to: col('public', 'users', 'id')
    }
    expect(
      summarizeUsage(
        { recordId: 'kn-r', kind: 'relationship', role: 'joins-from' },
        standard,
        col('public', 'orders', 'user_id')
      )
    ).toBe('Joins to public.users.id')
    expect(
      summarizeUsage(
        { recordId: 'kn-r', kind: 'relationship', role: 'joins-to' },
        standard,
        col('public', 'users', 'id')
      )
    ).toBe('Join target of public.orders.user_id')
  })

  it('describes glossary, note, exemplar, and annotation hits', () => {
    expect(
      summarizeUsage(
        { recordId: 'kn-g', kind: 'glossary', role: 'glossary-mapping' },
        glossary,
        col('public', 'orders', 'total')
      )
    ).toBe('Maps the term “Net revenue” — excludes tax')
    expect(
      summarizeUsage(
        { recordId: 'kn-n', kind: 'note', role: 'referenced-by-note' },
        note,
        col('public', 'users', 'deleted_at')
      )
    ).toBe('Referenced by note “Soft deletes”')
    expect(
      summarizeUsage(
        { recordId: 'kn-e', kind: 'exemplar', role: 'used-in-exemplar' },
        exemplar,
        col('public', 'users', 'deleted_at')
      )
    ).toBe('Used by exemplar “How many active users?”')
    expect(
      summarizeUsage(
        { recordId: 'kn-a', kind: 'annotation', role: 'annotates' },
        {
          ...envelope,
          id: 'kn-a',
          kind: 'annotation',
          target: col('public', 'users', 'email'),
          text: 'PII'
        },
        col('public', 'users', 'email')
      )
    ).toBe('Annotated: “PII”')
  })

  it('falls back gracefully when the record is missing', () => {
    expect(
      summarizeUsage(
        { recordId: 'kn-gone', kind: 'glossary', role: 'glossary-mapping' },
        undefined,
        col('public', 'orders', 'total')
      )
    ).toBe('Glossary mapping')
  })
})

describe('refSuggestions', () => {
  const intro: DatabaseIntrospection = {
    name: 'app',
    schemas: [
      {
        name: 'public',
        tables: [
          {
            name: 'users',
            columns: [
              { name: 'id', dataType: 'int', badge: 'pk' },
              { name: 'email', dataType: 'text', badge: null }
            ]
          }
        ],
        views: [{ name: 'active_users', columns: [{ name: 'id', dataType: 'int', badge: null }] }],
        matviews: [],
        indexes: [],
        functions: [],
        sequences: [],
        types: [],
        aggregates: []
      }
    ]
  }

  it('matches tables, views, and columns by substring, case-insensitively', () => {
    expect(refSuggestions(intro, 'EMAIL')).toEqual(['public.users.email'])
    expect(refSuggestions(intro, 'active')).toEqual([
      'public.active_users',
      'public.active_users.id'
    ])
  })

  it('returns everything for an empty filter, capped at the limit', () => {
    expect(refSuggestions(intro, '')).toEqual([
      'public.users',
      'public.users.id',
      'public.users.email',
      'public.active_users',
      'public.active_users.id'
    ])
    expect(refSuggestions(intro, '', 2)).toHaveLength(2)
    expect(refSuggestions(undefined, 'users')).toEqual([])
  })
})
