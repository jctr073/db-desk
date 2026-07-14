/**
 * Unit tests for the foreign-key reference graph in
 * src/renderer/src/connections/references.ts: real FK edges read from
 * introspection, logical FK edges inferred from naming conventions, the
 * singularization stems behind convention 1, and the per-column /
 * per-table direction queries the popover uses.
 */

import { describe, expect, it } from 'vitest'

import {
  buildReferenceIndex,
  columnKey,
  columnPeers,
  columnReferences,
  nameBasedPeers,
  parseFkRef,
  semanticPeers,
  singularStems,
  tableReferences,
  typeFamily
} from '../../src/renderer/src/connections/references'
import type { ReferenceEdge } from '../../src/renderer/src/connections/references'
import type {
  ColumnInfo,
  DatabaseIntrospection,
  RelationInfo,
  SchemaIntrospection
} from '../../src/shared/db'

function col(
  name: string,
  dataType = 'integer',
  badge: ColumnInfo['badge'] = null,
  fkRef: string | null = null
): ColumnInfo {
  return { name, dataType, badge, fkRef }
}

function rel(name: string, columns: ColumnInfo[]): RelationInfo {
  return { name, columns }
}

function schema(
  name: string,
  tables: RelationInfo[],
  views: RelationInfo[] = [],
  matviews: RelationInfo[] = []
): SchemaIntrospection {
  return {
    name,
    tables,
    views,
    matviews,
    indexes: [],
    functions: [],
    sequences: [],
    types: [],
    aggregates: []
  }
}

function db(...schemas: SchemaIntrospection[]): DatabaseIntrospection {
  return { name: 'app', schemas }
}

function edgeKey(edge: ReferenceEdge): string {
  return [
    edge.kind,
    edge.from.schema,
    edge.from.table,
    edge.from.column,
    edge.to.schema,
    edge.to.table,
    edge.to.column
  ].join(' ')
}

describe('singularStems', () => {
  it('strips a plain plural s', () => {
    expect(singularStems('customers')).toContain('customer')
  })

  it('handles -ies plurals', () => {
    expect(singularStems('categories')).toContain('category')
  })

  it('handles -es plurals like statuses, boxes, addresses', () => {
    expect(singularStems('statuses')).toContain('status')
    expect(singularStems('boxes')).toContain('box')
    expect(singularStems('addresses')).toContain('address')
  })

  it('handles irregular plurals', () => {
    expect(singularStems('people')).toContain('person')
    expect(singularStems('children')).toContain('child')
  })

  it('leaves uninflectable words alone', () => {
    expect(singularStems('data')).toContain('data')
    expect(singularStems('media')).toContain('media')
  })

  it('inflects only the last word of a compound name', () => {
    expect(singularStems('order_statuses')).toContain('order_status')
    expect(singularStems('team_people')).toContain('team_person')
  })

  it('always includes the name itself (already-singular tables)', () => {
    expect(singularStems('customer')).toContain('customer')
  })
})

describe('typeFamily', () => {
  it('folds integer widths into one family', () => {
    expect(typeFamily('integer')).toBe(typeFamily('bigint'))
    expect(typeFamily('smallint')).toBe(typeFamily('integer'))
  })

  it('folds text-ish types into one family', () => {
    expect(typeFamily('text')).toBe(typeFamily('character varying(255)'))
  })

  it('keeps incompatible families apart', () => {
    expect(typeFamily('uuid')).not.toBe(typeFamily('integer'))
    expect(typeFamily('text')).not.toBe(typeFamily('integer'))
  })
})

describe('parseFkRef', () => {
  it('splits schema.table.column', () => {
    expect(parseFkRef('public.customers.id')).toEqual({
      schema: 'public',
      table: 'customers',
      column: 'id'
    })
  })

  it('keeps extra dots in the schema part', () => {
    expect(parseFkRef('my.schema.customers.id')).toEqual({
      schema: 'my.schema',
      table: 'customers',
      column: 'id'
    })
  })

  it('rejects malformed refs', () => {
    expect(parseFkRef('customers.id')).toBeNull()
  })
})

describe('buildReferenceIndex', () => {
  const fixture = db(
    schema(
      'public',
      [
        rel('customers', [col('id', 'integer', 'pk'), col('name', 'text')]),
        // Declared FK: must come through as 'fk', never doubled as 'lfk'.
        rel('payments', [
          col('id', 'integer', 'pk'),
          col('customer_id', 'integer', 'fk', 'public.customers.id')
        ]),
        // Convention 1: customers.id <- orders.customer_id.
        rel('orders', [col('id', 'integer', 'pk'), col('customer_id', 'bigint')]),
        // Type mismatch: no logical edge.
        rel('reviews', [col('id', 'integer', 'pk'), col('customer_id', 'text')]),
        // Convention 2: warehouses.warehouse_id <- shipments.warehouse_id,
        // and no self-edge for warehouses' own pk column.
        rel('warehouses', [col('warehouse_id', 'integer', 'pk')]),
        rel('shipments', [col('id', 'integer', 'pk'), col('warehouse_id', 'integer')]),
        // Composite PK: no inference from order_items' own key, but its
        // order_id column still logically references orders.
        rel('order_items', [
          col('order_id', 'integer', 'pk'),
          col('item_no', 'integer', 'pk')
        ]),
        // Irregular plural: statuses.id <- tickets.status_id.
        rel('statuses', [col('id', 'integer', 'pk')]),
        rel('tickets', [col('id', 'integer', 'pk'), col('status_id', 'integer')])
      ],
      [
        // Views count as referencing objects.
        rel('customer_summary', [col('customer_id', 'integer'), col('total', 'numeric')])
      ]
    ),
    schema('billing', [
      // Cross-schema logical reference back to public.customers.
      rel('invoices', [col('id', 'integer', 'pk'), col('customer_id', 'integer')])
    ])
  )

  const index = buildReferenceIndex(fixture)
  const keys = new Set(index.edges.map(edgeKey))

  it('keeps declared FKs as fk edges only', () => {
    expect(keys).toContain('fk public payments customer_id public customers id')
    const paymentEdges = index.edges.filter(
      (e) => e.from.table === 'payments' && e.from.column === 'customer_id'
    )
    expect(paymentEdges).toHaveLength(1)
  })

  it('infers convention-1 logical FKs (plural table, pk "id")', () => {
    expect(keys).toContain('lfk public orders customer_id public customers id')
  })

  it('infers convention-2 logical FKs (pk named like the column)', () => {
    expect(keys).toContain(
      'lfk public shipments warehouse_id public warehouses warehouse_id'
    )
  })

  it('never emits a self-edge for a convention-2 pk column', () => {
    expect(
      index.edges.some(
        (e) => e.from.table === 'warehouses' && e.to.table === 'warehouses'
      )
    ).toBe(false)
  })

  it('rejects logical pairs across type families', () => {
    expect(
      index.edges.some((e) => e.from.table === 'reviews' && e.kind === 'lfk')
    ).toBe(false)
  })

  it('skips inference targets for composite PKs but still matches their columns', () => {
    // order_items has no single-column pk, so nothing points at it…
    expect(index.edges.some((e) => e.to.table === 'order_items')).toBe(false)
    // …but its own order_id column references orders.
    expect(keys).toContain('lfk public order_items order_id public orders id')
  })

  it('handles irregular plurals via singular stems', () => {
    expect(keys).toContain('lfk public tickets status_id public statuses id')
  })

  it('includes views as referencing objects and labels their kind', () => {
    const viewEdge = index.edges.find((e) => e.from.table === 'customer_summary')
    expect(viewEdge?.kind).toBe('lfk')
    expect(viewEdge?.fromRelationKind).toBe('view')
    expect(viewEdge?.to.table).toBe('customers')
  })

  it('matches across schemas within the database', () => {
    expect(keys).toContain('lfk billing invoices customer_id public customers id')
  })

  it('records inferred targets for tree badges, keyed by source column', () => {
    expect(
      index.logicalRefs.get(columnKey('public', 'orders', 'customer_id'))
    ).toBe('public.customers.id')
    // Declared FKs get no logical badge entry.
    expect(
      index.logicalRefs.has(columnKey('public', 'payments', 'customer_id'))
    ).toBe(false)
  })

  it('answers column-level direction queries', () => {
    const pk = columnReferences(index, {
      schema: 'public',
      table: 'customers',
      column: 'id'
    })
    expect(pk.outbound).toHaveLength(0)
    expect(pk.inbound.map((e) => e.from.table).sort()).toEqual([
      'customer_summary',
      'invoices',
      'orders',
      'payments'
    ])

    const fkCol = columnReferences(index, {
      schema: 'public',
      table: 'orders',
      column: 'customer_id'
    })
    expect(fkCol.outbound.map(edgeKey)).toEqual([
      'lfk public orders customer_id public customers id'
    ])
    expect(fkCol.inbound).toHaveLength(0)
  })

  it('answers table-level direction queries', () => {
    const customers = tableReferences(index, 'public', 'customers')
    expect(customers.outbound).toHaveLength(0)
    expect(customers.inbound.map((e) => e.from.table).sort()).toEqual([
      'customer_summary',
      'invoices',
      'orders',
      'payments'
    ])

    const orders = tableReferences(index, 'public', 'orders')
    expect(orders.outbound.map((e) => e.to.table)).toEqual(['customers'])
    expect(orders.inbound.map((e) => e.from.table)).toEqual(['order_items'])
  })
})

describe('column peers', () => {
  it('finds semantic peers through a shared target and excludes the subject', () => {
    const fixture = db(
      schema('public', [
        rel('contracts', [col('id', 'integer', 'pk')]),
        rel('orders', [
          col('contract_id', 'integer', 'fk', 'public.contracts.id')
        ]),
        rel('invoices', [
          col('contract_id', 'integer', 'fk', 'public.contracts.id')
        ]),
        rel('shipments', [col('contract_id', 'integer')])
      ])
    )
    const index = buildReferenceIndex(fixture)
    const subject = { schema: 'public', table: 'orders', column: 'contract_id' }

    const peers = semanticPeers(index, subject)
    expect(peers.map((edge) => `${edge.kind} ${edge.from.table}`)).toEqual([
      'fk invoices',
      'lfk shipments'
    ])
    expect(peers.some((edge) => edge.from.table === 'orders')).toBe(false)
  })

  it('uses name-based peers for a targetless column and excludes type mismatches', () => {
    const fixture = db(
      schema('public', [
        rel('orders', [col('country_code', 'text')]),
        rel('customers', [col('COUNTRY_CODE', 'varchar(2)')]),
        rel('imports', [col('country_code', 'uuid')]),
        rel('products', [col('sku', 'text')]),
        rel('warehouses', [col('location', 'text')]),
        rel('carriers', [col('code', 'text')]),
        rel('regions', [col('label', 'text')]),
        rel('payments', [col('amount', 'numeric')]),
        rel('shipments', [col('tracking_number', 'text')]),
        rel('events', [col('payload', 'jsonb')])
      ])
    )
    const subject = {
      schema: 'public',
      table: 'orders',
      column: 'country_code'
    }
    const result = columnPeers(buildReferenceIndex(fixture), fixture, subject)

    expect(result).toEqual({
      kind: 'name',
      peers: [
        {
          endpoint: {
            schema: 'public',
            table: 'customers',
            column: 'COUNTRY_CODE'
          },
          relationKind: 'table'
        }
      ]
    })
  })

  it('does not fall back to name matching when the subject resolves to a target', () => {
    const fixture = db(
      schema('public', [
        rel('accounts', [col('id', 'integer', 'pk')]),
        rel('orders', [
          col('account_key', 'integer', 'fk', 'public.accounts.id')
        ]),
        rel('imports', [col('account_key', 'integer')]),
        rel('products', [col('sku', 'text')]),
        rel('warehouses', [col('location', 'text')]),
        rel('carriers', [col('code', 'text')]),
        rel('regions', [col('label', 'text')])
      ])
    )
    const result = columnPeers(buildReferenceIndex(fixture), fixture, {
      schema: 'public',
      table: 'orders',
      column: 'account_key'
    })

    expect(result).toEqual({ kind: null, peers: [] })
  })

  it('suppresses stoplisted names', () => {
    const fixture = db(
      schema('public', [
        rel('orders', [col('name', 'text')]),
        rel('customers', [col('name', 'text')]),
        rel('products', [col('sku', 'text')]),
        rel('warehouses', [col('location', 'text')]),
        rel('carriers', [col('code', 'text')]),
        rel('regions', [col('label', 'text')]),
        rel('imports', [col('source', 'text')])
      ])
    )

    expect(
      nameBasedPeers(fixture, {
        schema: 'public',
        table: 'orders',
        column: 'name'
      })
    ).toEqual([])
  })

  it('suppresses names present in more than 30% of relations', () => {
    const fixture = db(
      schema('public', [
        rel('orders', [col('tenant_id', 'integer')]),
        rel('customers', [col('tenant_id', 'integer')]),
        rel('products', [col('tenant_id', 'integer')]),
        rel('warehouses', [col('location', 'text')]),
        rel('carriers', [col('code', 'text')]),
        rel('regions', [col('label', 'text')]),
        rel('imports', [col('source', 'text')])
      ])
    )

    expect(
      nameBasedPeers(fixture, {
        schema: 'public',
        table: 'orders',
        column: 'tenant_id'
      })
    ).toEqual([])
  })
})
