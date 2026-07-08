/**
 * The statement corpus behind the agent's read-only wall.
 *
 * One table, two consumers:
 *
 *   test/unit/sql.test.ts                 asserts classifyStatement(sql) === expected
 *                                         (once it exists -- docs/agent-modes.md step 1)
 *   test/integration/postgres/corpus...   runs every case against a real Postgres in a
 *                                         read-only session and asserts `underReadOnly`
 *                                         and `mutates` still describe reality
 *
 * `expected` is a *rule* -- what our classifier must say. `underReadOnly` and
 * `mutates` are *observations*, recorded against postgres:17-alpine. If an
 * integration assertion fails, the engine changed its behaviour; that is news,
 * not a broken test. The two together prove the safety property the integration
 * suite asserts directly:
 *
 *     expected === 'read'  =>  the statement never mutated anything
 *
 * ...and its converse, which is why the client-side wall must exist at all:
 * several cases below are `permitted` by the read-only session yet still mutate.
 */

export type StatementClass = 'read' | 'dml' | 'ddl' | 'unknown'

export interface StatementCase {
  name: string
  sql: string
  /** What classifyStatement must return (docs/agent-modes.md §3). */
  expected: StatementClass
  /** Observed: does Postgres's read-only session reject the statement? */
  underReadOnly: 'rejected' | 'permitted'
  /** Observed: did table data change after running it in a read-only session? */
  mutates: boolean
  /** Set when the case cannot run against Postgres (other dialect, or unsupported). */
  skipIntegration?: string
  note?: string
}

/** Statements that must classify as `read` -- the only class the agent may run. */
export const READ_CASES: StatementCase[] = [
  { name: 'trivial select', sql: 'SELECT 1', expected: 'read', underReadOnly: 'permitted', mutates: false },
  { name: 'lowercase select', sql: 'select * from customers', expected: 'read', underReadOnly: 'permitted', mutates: false },
  { name: 'mixed case', sql: 'sElEcT 1', expected: 'read', underReadOnly: 'permitted', mutates: false },
  { name: 'leading line comment', sql: '-- a comment\nSELECT 1', expected: 'read', underReadOnly: 'permitted', mutates: false },
  { name: 'leading block comment', sql: '/* hi */ SELECT 1', expected: 'read', underReadOnly: 'permitted', mutates: false },
  { name: 'trailing semicolon', sql: 'SELECT 1;', expected: 'read', underReadOnly: 'permitted', mutates: false },
  { name: 'TABLE', sql: 'TABLE customers', expected: 'read', underReadOnly: 'permitted', mutates: false },
  { name: 'VALUES', sql: 'VALUES (1), (2)', expected: 'read', underReadOnly: 'permitted', mutates: false },
  { name: 'read-only CTE', sql: 'WITH x AS (SELECT 1 AS n) SELECT * FROM x', expected: 'read', underReadOnly: 'permitted', mutates: false },
  { name: 'join', sql: 'SELECT c.email, o.reference FROM customers c JOIN orders o ON o.customer_id = c.id', expected: 'read', underReadOnly: 'permitted', mutates: false },
  { name: 'SHOW', sql: 'SHOW search_path', expected: 'read', underReadOnly: 'permitted', mutates: false },
  { name: 'EXPLAIN of a select', sql: 'EXPLAIN SELECT * FROM customers', expected: 'read', underReadOnly: 'permitted', mutates: false },
  { name: 'EXPLAIN ANALYZE of a select', sql: 'EXPLAIN (FORMAT TEXT, ANALYZE, BUFFERS) SELECT * FROM customers', expected: 'read', underReadOnly: 'permitted', mutates: false },
  { name: 'DDL keyword inside a string literal', sql: "SELECT 'DROP TABLE customers' AS spooky", expected: 'read', underReadOnly: 'permitted', mutates: false },
  { name: 'DML keyword inside a comment', sql: 'SELECT /* delete from customers */ 1', expected: 'read', underReadOnly: 'permitted', mutates: false },
  { name: 'DML keyword as a quoted identifier', sql: 'SELECT 1 AS "delete"', expected: 'read', underReadOnly: 'permitted', mutates: false },
  { name: 'dollar-quoted DDL text', sql: 'SELECT $tag$ DROP TABLE customers $tag$', expected: 'read', underReadOnly: 'permitted', mutates: false },
  { name: 'DESCRIBE (Databricks)', sql: 'DESCRIBE customers', expected: 'read', underReadOnly: 'permitted', mutates: false, skipIntegration: 'DESCRIBE is not Postgres syntax' },
  { name: 'DESC (Databricks)', sql: 'DESC customers', expected: 'read', underReadOnly: 'permitted', mutates: false, skipIntegration: 'DESC is not Postgres syntax' },
  { name: 'backtick identifier (Databricks)', sql: 'SELECT `update` FROM customers', expected: 'read', underReadOnly: 'permitted', mutates: false, skipIntegration: 'backtick identifiers are not Postgres syntax' }
]

/** Statements that modify data. */
export const DML_CASES: StatementCase[] = [
  { name: 'DELETE', sql: 'DELETE FROM order_items', expected: 'dml', underReadOnly: 'rejected', mutates: false },
  { name: 'INSERT', sql: "INSERT INTO customers (email, full_name) VALUES ('new@example.com', 'New')", expected: 'dml', underReadOnly: 'rejected', mutates: false },
  { name: 'UPDATE', sql: "UPDATE orders SET status = 'paid'", expected: 'dml', underReadOnly: 'rejected', mutates: false },
  { name: 'TRUNCATE', sql: 'TRUNCATE order_items', expected: 'dml', underReadOnly: 'rejected', mutates: false },
  {
    name: 'MERGE',
    sql: "MERGE INTO customers c USING (SELECT 'ada@example.com'::text AS email) s ON c.email = s.email WHEN MATCHED THEN UPDATE SET full_name = 'Merged'",
    expected: 'dml',
    underReadOnly: 'rejected',
    mutates: false
  },
  { name: 'top-level DML after a CTE', sql: 'WITH x AS (SELECT 1) DELETE FROM order_items', expected: 'dml', underReadOnly: 'rejected', mutates: false },
  {
    name: 'data-modifying CTE (nested DML)',
    sql: 'WITH x AS (DELETE FROM order_items RETURNING *) SELECT * FROM x',
    expected: 'dml',
    underReadOnly: 'rejected',
    mutates: false,
    note: "statementModifiesData() calls this a read: the DML sits at paren depth 1 and scanTopLevel only looks at depth 0. Postgres's belt catches it; a classifier-only engine would not."
  },
  { name: 'EXPLAIN of an UPDATE', sql: "EXPLAIN UPDATE orders SET status = 'paid'", expected: 'dml', underReadOnly: 'permitted', mutates: false, note: 'Postgres plans it happily -- no execution, no mutation. We block it anyway (decision C): EXPLAIN ANALYZE of the same statement would execute it, and we do not want the distinction to rest on parsing option lists.' },
  { name: 'EXPLAIN ANALYZE of an UPDATE', sql: "EXPLAIN (ANALYZE) UPDATE orders SET status = 'paid'", expected: 'dml', underReadOnly: 'rejected', mutates: false, note: 'ANALYZE really executes it; only the read-only session stops the write.' },
  { name: 'COPY FROM', sql: "COPY customers FROM '/tmp/customers.csv'", expected: 'dml', underReadOnly: 'rejected', mutates: false, skipIntegration: 'COPY needs a server-side file and the copy protocol' }
]

/** Statements that change database structure. */
export const DDL_CASES: StatementCase[] = [
  { name: 'CREATE TABLE', sql: 'CREATE TABLE probe_created (a int)', expected: 'ddl', underReadOnly: 'rejected', mutates: false },
  { name: 'ALTER TABLE', sql: 'ALTER TABLE customers ADD COLUMN nickname text', expected: 'ddl', underReadOnly: 'rejected', mutates: false },
  { name: 'DROP TABLE', sql: 'DROP TABLE order_items', expected: 'ddl', underReadOnly: 'rejected', mutates: false },
  { name: 'GRANT', sql: 'GRANT SELECT ON customers TO dbdesk_ro', expected: 'ddl', underReadOnly: 'rejected', mutates: false },
  { name: 'REVOKE', sql: 'REVOKE SELECT ON customers FROM dbdesk_ro', expected: 'ddl', underReadOnly: 'rejected', mutates: false },
  { name: 'COMMENT', sql: "COMMENT ON TABLE customers IS 'owned'", expected: 'ddl', underReadOnly: 'rejected', mutates: false },
  { name: 'SELECT INTO creates a table', sql: 'SELECT * INTO probe_into FROM customers', expected: 'ddl', underReadOnly: 'rejected', mutates: false },
  { name: 'VACUUM', sql: 'VACUUM customers', expected: 'ddl', underReadOnly: 'permitted', mutates: false, note: 'Not in the read-only session prohibition list -- it writes to disk but not to table data.' },
  { name: 'EXPLAIN of DDL', sql: 'EXPLAIN CREATE TABLE probe_created (a int)', expected: 'ddl', underReadOnly: 'rejected', mutates: false, skipIntegration: 'Postgres cannot EXPLAIN a CREATE TABLE' },
  { name: 'REFRESH MATERIALIZED VIEW', sql: 'REFRESH MATERIALIZED VIEW nothing', expected: 'ddl', underReadOnly: 'rejected', mutates: false, skipIntegration: 'no materialized view is seeded' }
]

/**
 * Everything else. Not provably a read, so the wall refuses it.
 * The multi-statement entries flagged `mutates` are the ones that make the
 * client-side wall load-bearing: Postgres's read-only session lets them through.
 */
export const UNKNOWN_CASES: StatementCase[] = [
  { name: 'SET alone', sql: 'SET default_transaction_read_only = off', expected: 'unknown', underReadOnly: 'permitted', mutates: false },
  { name: 'RESET ALL', sql: 'RESET ALL', expected: 'unknown', underReadOnly: 'permitted', mutates: false },
  { name: 'BEGIN', sql: 'BEGIN', expected: 'unknown', underReadOnly: 'permitted', mutates: false },
  { name: 'COMMIT', sql: 'COMMIT', expected: 'unknown', underReadOnly: 'permitted', mutates: false },
  { name: 'LOCK TABLE', sql: 'LOCK TABLE customers', expected: 'unknown', underReadOnly: 'rejected', mutates: false, note: 'LOCK defaults to ACCESS EXCLUSIVE, which a read-only transaction refuses (25006).' },
  { name: 'SELECT FOR UPDATE takes row locks', sql: 'SELECT * FROM customers FOR UPDATE', expected: 'unknown', underReadOnly: 'rejected', mutates: false },
  { name: 'DO block that writes', sql: "DO $$ BEGIN INSERT INTO customers (email, full_name) VALUES ('do@example.com', 'Do'); END $$", expected: 'unknown', underReadOnly: 'rejected', mutates: false },
  { name: 'SELECT calling a volatile function that writes', sql: "SELECT add_customer('volatile@example.com', 'Volatile')", expected: 'read', underReadOnly: 'rejected', mutates: false, note: 'THE case no client-side classifier can see: a plain SELECT that writes. Classified `read`, and correctly so -- only the server-side belt (or a read-only role) stops it. This is the documented residual risk.' },
  { name: 'two reads', sql: 'SELECT 1; SELECT 2', expected: 'unknown', underReadOnly: 'permitted', mutates: false, note: 'Harmless, but multi-statement input is refused wholesale -- see the escapes below.' },

  // --- The escapes. Each is a single string the agent could pass to run_sql. ---
  {
    name: 'ESCAPE: SET transaction_read_only = off',
    sql: 'SET transaction_read_only = off; DELETE FROM order_items',
    expected: 'unknown',
    underReadOnly: 'permitted',
    mutates: true,
    note: 'Flips the *current* transaction read-only flag. Deletes every row.'
  },
  {
    name: 'ESCAPE: BEGIN; SET TRANSACTION READ WRITE',
    sql: 'BEGIN; SET TRANSACTION READ WRITE; DELETE FROM order_items; COMMIT',
    expected: 'unknown',
    underReadOnly: 'permitted',
    mutates: true
  },
  {
    name: 'ESCAPE: START TRANSACTION READ WRITE',
    sql: 'START TRANSACTION READ WRITE; DELETE FROM order_items; COMMIT',
    expected: 'unknown',
    underReadOnly: 'permitted',
    mutates: true
  },
  {
    name: 'ESCAPE: COMMIT out of the implicit transaction, then reset the default',
    sql: 'COMMIT; SET default_transaction_read_only = off; COMMIT; DELETE FROM order_items',
    expected: 'unknown',
    underReadOnly: 'permitted',
    mutates: true,
    note: 'The first COMMIT ends the implicit read-only transaction; the DELETE then opens a fresh, writable one.'
  },
  {
    name: 'ESCAPE: ABORT variant',
    sql: 'ABORT; SET default_transaction_read_only = off; COMMIT; DELETE FROM order_items',
    expected: 'unknown',
    underReadOnly: 'permitted',
    mutates: true
  },

  // --- Near misses: multi-statement, but the belt happens to hold. ---
  {
    name: 'near miss: SET default_transaction_read_only = off; DELETE',
    sql: 'SET default_transaction_read_only = off; DELETE FROM order_items',
    expected: 'unknown',
    underReadOnly: 'rejected',
    mutates: false,
    note: 'Changing the *default* does not change the in-flight implicit transaction, so the DELETE still fails. An earlier draft of docs/agent-modes.md named this exact payload as the live bypass; it is not one. The three ESCAPE cases above are.'
  },
  {
    name: 'near miss: SET SESSION CHARACTERISTICS',
    sql: 'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE; DELETE FROM order_items',
    expected: 'unknown',
    underReadOnly: 'rejected',
    mutates: false
  },
  {
    name: 'near miss: single COMMIT then DELETE',
    sql: 'COMMIT; SET default_transaction_read_only = off; DELETE FROM order_items',
    expected: 'unknown',
    underReadOnly: 'rejected',
    mutates: false
  },
  { name: 'CALL a procedure', sql: 'CALL some_procedure()', expected: 'unknown', underReadOnly: 'rejected', mutates: false, skipIntegration: 'no procedure is seeded' },
  { name: 'USE catalog (Databricks)', sql: 'USE CATALOG main', expected: 'unknown', underReadOnly: 'rejected', mutates: false, skipIntegration: 'USE CATALOG is not Postgres syntax' }
]

export const ALL_CASES: StatementCase[] = [
  ...READ_CASES,
  ...DML_CASES,
  ...DDL_CASES,
  ...UNKNOWN_CASES
]

/** Cases the Postgres integration sweep can actually execute. */
export const PG_CASES: StatementCase[] = ALL_CASES.filter(
  (c) => !c.skipIntegration
)

/** The reason the agent needs a client-side wall: the belt lets these through. */
export const ESCAPE_CASES: StatementCase[] = ALL_CASES.filter((c) => c.mutates)
