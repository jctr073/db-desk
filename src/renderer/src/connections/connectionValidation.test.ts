import { describe, expect, it } from 'vitest'

import { DIALECTS } from '../../../shared/dialect'
import { databaseFieldError, environmentFieldError } from './connectionValidation'

const postgres = DIALECTS.postgres
const databricks = DIALECTS.databricks

describe('databaseFieldError', () => {
  it('requires a database for single-database dialects in params mode', () => {
    expect(databaseFieldError(postgres, true, '', '')).toBe('DATABASE is required.')
    expect(databaseFieldError(postgres, true, '   ', '')).toBe('DATABASE is required.')
    expect(databaseFieldError(postgres, true, 'postgres', '')).toBeNull()
  })

  it('requires a database path segment for single-database dialects in URL mode', () => {
    expect(databaseFieldError(postgres, false, '', 'postgresql://user@host:5432')).toBe(
      'Connection URL must include a database (e.g. postgresql://user:password@host:port/database).'
    )
    expect(databaseFieldError(postgres, false, '', 'postgresql://user@host:5432/')).toContain(
      'must include a database'
    )
    expect(databaseFieldError(postgres, false, '', 'postgresql://user@host:5432/app_db')).toBeNull()
  })

  it('leaves an unparseable URL to the existing connect-time error', () => {
    expect(databaseFieldError(postgres, false, '', '')).toBeNull()
    expect(databaseFieldError(postgres, false, '', 'not a url')).toBeNull()
  })

  it('never requires a database for multi-database dialects (Databricks)', () => {
    expect(databaseFieldError(databricks, true, '', '')).toBeNull()
    expect(databaseFieldError(databricks, false, '', '')).toBeNull()
  })
})

describe('environmentFieldError', () => {
  it('requires a pick — there is no default selection', () => {
    expect(environmentFieldError(null)).toBe('Choose an environment.')
  })

  it('accepts any of the known tiers', () => {
    expect(environmentFieldError('dev')).toBeNull()
    expect(environmentFieldError('stage')).toBeNull()
    expect(environmentFieldError('prod')).toBeNull()
  })
})
