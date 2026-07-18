import { describe, expect, it } from 'vitest'

import type { DatabaseIntrospection } from '../../src/shared/db'
import { assignIds, databaseChildren } from '../../src/renderer/src/connections/treeData'
import type { TreeNode } from '../../src/renderer/src/connections/types'

const intro: DatabaseIntrospection = {
  name: 'app_db',
  schemas: [
    {
      name: 'public',
      tables: [],
      views: [],
      matviews: [],
      indexes: [],
      functions: [],
      sequences: [],
      types: [
        { name: 'game_type', kind: 'enum', values: ['single_player', 'co-op'] },
        { name: 'account', kind: 'composite' }
      ],
      aggregates: []
    }
  ]
}

function dataTypesNode(): TreeNode {
  const schema = databaseChildren(intro)[0]
  assignIds(schema, 'connection/database')
  const dataTypes = schema.children?.find((node) => node.key === 'types')
  if (!dataTypes) throw new Error('Data Types category was not created')
  return dataTypes
}

describe('enum data types in the connection tree', () => {
  it('adds enum labels in database sort order as expandable children', () => {
    const gameType = dataTypesNode().children?.find((node) => node.label === 'game_type')

    expect(gameType?.children).toEqual([
      expect.objectContaining({ kind: 'enumValue', label: 'single_player' }),
      expect.objectContaining({ kind: 'enumValue', label: 'co-op' })
    ])
    expect(gameType?.children?.map((node) => node.id)).toEqual([
      'connection/database/public/types/game_type/value-0',
      'connection/database/public/types/game_type/value-1'
    ])
  })

  it('keeps non-enum data types as leaf rows', () => {
    const account = dataTypesNode().children?.find((node) => node.label === 'account')

    expect(account?.children).toBeUndefined()
  })
})
