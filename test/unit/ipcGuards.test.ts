import { describe, expect, it } from 'vitest'

import {
  validateMcpServerConfig,
  validateSchemaSelectionConfig,
  validateSetEnvironmentPayload,
  validateStoreSavePayload
} from '../../src/main/ipcGuards'
import type { ConnectParams } from '../../src/shared/db'
import type { McpServerConfig } from '../../src/shared/mcp'
import type { SchemaSelectionConfig } from '../../src/shared/schemaSelection'

const validParams: ConnectParams = {
  type: 'postgres',
  host: 'localhost',
  port: '5432',
  database: 'analytics',
  user: 'dbdesk',
  password: 'secret',
  httpPath: '',
  url: '',
  useUrl: false,
  environment: 'dev'
}

describe('validateStoreSavePayload', () => {
  it('accepts a well-formed save payload', () => {
    expect(() => validateStoreSavePayload('conn-1', 'Local PG', validParams, true)).not.toThrow()
  })

  it('accepts a Databricks payload with useUrl', () => {
    const params: ConnectParams = {
      ...validParams,
      type: 'databricks',
      httpPath: '/sql/1.0/warehouses/abc',
      url: 'databricks://host',
      useUrl: true
    }
    expect(() => validateStoreSavePayload('conn-2', 'Bricks', params, false)).not.toThrow()
  })

  it.each(['', '   ', 42, null, undefined])('rejects invalid id %j', (id) => {
    expect(() => validateStoreSavePayload(id, 'Name', validParams, true)).toThrow(
      'Connection id must be a non-empty string'
    )
  })

  it('rejects a non-string name', () => {
    expect(() => validateStoreSavePayload('conn-1', 7, validParams, true)).toThrow(
      'Connection name must be a string'
    )
  })

  it('rejects a non-boolean savePassword', () => {
    expect(() => validateStoreSavePayload('conn-1', 'Name', validParams, 'yes')).toThrow(
      'savePassword must be a boolean'
    )
  })

  it.each([null, 'params', ['x'], 42])('rejects non-object params %j', (params) => {
    expect(() => validateStoreSavePayload('conn-1', 'Name', params, true)).toThrow(
      'Connection params must be an object'
    )
  })

  it('rejects an unknown connection type', () => {
    expect(() =>
      validateStoreSavePayload('conn-1', 'Name', { ...validParams, type: 'mysql' }, true)
    ).toThrow('Unknown connection type: mysql')
  })

  it.each(['host', 'port', 'database', 'user', 'password', 'httpPath', 'url'])(
    'rejects a non-string %s field',
    (field) => {
      const params = { ...validParams, [field]: 99 }
      expect(() => validateStoreSavePayload('conn-1', 'Name', params, true)).toThrow(
        `Connection ${field} must be a string`
      )
    }
  )

  it('rejects a non-boolean useUrl', () => {
    expect(() =>
      validateStoreSavePayload('conn-1', 'Name', { ...validParams, useUrl: 'true' }, true)
    ).toThrow('Connection useUrl must be a boolean')
  })

  it.each(['dev', 'stage', 'prod'])('accepts a valid environment %s', (environment) => {
    expect(() =>
      validateStoreSavePayload('conn-1', 'Name', { ...validParams, environment }, true)
    ).not.toThrow()
  })

  it.each([null, undefined])(
    'accepts a missing/null environment (legacy callers)',
    (environment) => {
      expect(() =>
        validateStoreSavePayload('conn-1', 'Name', { ...validParams, environment }, true)
      ).not.toThrow()
    }
  )

  it('rejects an out-of-enum environment string', () => {
    expect(() =>
      validateStoreSavePayload(
        'conn-1',
        'Name',
        { ...validParams, environment: 'production' },
        true
      )
    ).toThrow('Unknown connection environment: production')
  })

  it('rejects a non-string environment', () => {
    expect(() =>
      validateStoreSavePayload('conn-1', 'Name', { ...validParams, environment: 3 }, true)
    ).toThrow('Unknown connection environment: 3')
  })
})

describe('validateSetEnvironmentPayload', () => {
  it.each(['dev', 'stage', 'prod'])('accepts a valid environment %s', (environment) => {
    expect(() => validateSetEnvironmentPayload('conn-1', environment)).not.toThrow()
  })

  it('rejects a missing id', () => {
    expect(() => validateSetEnvironmentPayload('', 'dev')).toThrow(
      'Connection id must be a non-empty string'
    )
  })

  it('rejects an out-of-enum environment string', () => {
    expect(() => validateSetEnvironmentPayload('conn-1', 'production')).toThrow(
      'Unknown connection environment: production'
    )
  })

  it.each([null, undefined, 42])('rejects a missing/wrong-typed environment %j', (environment) => {
    expect(() => validateSetEnvironmentPayload('conn-1', environment)).toThrow(
      'Unknown connection environment'
    )
  })
})

describe('validateSchemaSelectionConfig', () => {
  const validConfig: SchemaSelectionConfig = {
    catalogs: ['main', 'samples'],
    schemas: { main: ['contract_db', 'billing'], samples: [] }
  }

  it('accepts a well-formed config', () => {
    expect(() => validateSchemaSelectionConfig('conn-1', validConfig)).not.toThrow()
  })

  it('accepts null catalogs (no pinning) and an empty schema map', () => {
    expect(() =>
      validateSchemaSelectionConfig('conn-1', { catalogs: null, schemas: {} })
    ).not.toThrow()
  })

  it('rejects a missing id', () => {
    expect(() => validateSchemaSelectionConfig('', validConfig)).toThrow(
      'Connection id must be a non-empty string'
    )
  })

  it.each([null, 'config', 12])('rejects non-object config %j', (config) => {
    expect(() => validateSchemaSelectionConfig('conn-1', config)).toThrow(
      'Schema selection config must be an object'
    )
  })

  it.each(['main', { main: true }, [1, 2], undefined])(
    'rejects invalid catalogs %j',
    (catalogs) => {
      expect(() => validateSchemaSelectionConfig('conn-1', { catalogs, schemas: {} })).toThrow(
        'catalogs must be null or a string array'
      )
    }
  )

  it.each([null, ['a'], 'main'])('rejects invalid schemas %j', (schemas) => {
    expect(() => validateSchemaSelectionConfig('conn-1', { catalogs: null, schemas })).toThrow(
      'schemas must be an object of catalog to schema names'
    )
  })

  it('rejects a schema list holding non-strings', () => {
    expect(() =>
      validateSchemaSelectionConfig('conn-1', { catalogs: null, schemas: { main: ['ok', 3] } })
    ).toThrow('Schema selection for catalog main must be a string array')
  })
})

describe('validateMcpServerConfig', () => {
  const validConfig: McpServerConfig = {
    id: 'mcp-1',
    name: 'files',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    env: { API_TOKEN: 'abc' },
    enabled: true
  }

  it('accepts a well-formed config', () => {
    expect(() => validateMcpServerConfig(validConfig)).not.toThrow()
  })

  it.each([null, 'config', ['x']])('rejects non-object config %j', (config) => {
    expect(() => validateMcpServerConfig(config)).toThrow('MCP server config must be an object')
  })

  it.each(['id', 'name', 'command'] as const)('rejects a missing or empty %s', (field) => {
    expect(() => validateMcpServerConfig({ ...validConfig, [field]: '' })).toThrow(
      `MCP server ${field} must be a non-empty string`
    )
    expect(() => validateMcpServerConfig({ ...validConfig, [field]: undefined })).toThrow(
      `MCP server ${field} must be a non-empty string`
    )
  })

  it('rejects args holding non-strings', () => {
    expect(() => validateMcpServerConfig({ ...validConfig, args: ['ok', 1] })).toThrow(
      'MCP server args must be a string array'
    )
  })

  it('rejects a non-array args', () => {
    expect(() => validateMcpServerConfig({ ...validConfig, args: 'run' })).toThrow(
      'MCP server args must be a string array'
    )
  })

  it('rejects a non-object env', () => {
    expect(() => validateMcpServerConfig({ ...validConfig, env: ['A=b'] })).toThrow(
      'MCP server env must be an object'
    )
  })

  it('rejects env values that are not strings', () => {
    expect(() => validateMcpServerConfig({ ...validConfig, env: { PORT: 8080 } })).toThrow(
      'MCP server env value for PORT must be a string'
    )
  })

  it('rejects a non-boolean enabled', () => {
    expect(() => validateMcpServerConfig({ ...validConfig, enabled: 1 })).toThrow(
      'MCP server enabled must be a boolean'
    )
  })
})
