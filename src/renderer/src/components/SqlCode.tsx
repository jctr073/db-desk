import { useMemo } from 'react'
import type { ReactElement } from 'react'

import { highlightSql } from '../sql/highlight'

/** SQL text with the same token palette used by Monaco and agent chat. */
export function SqlCode({ sql }: { sql: string }): ReactElement {
  const segments = useMemo(() => highlightSql(sql), [sql])
  return (
    <>
      {segments.map((segment, index) =>
        segment.cls ? (
          <span key={index} className={`sql-${segment.cls}`}>
            {segment.text}
          </span>
        ) : (
          segment.text
        )
      )}
    </>
  )
}
