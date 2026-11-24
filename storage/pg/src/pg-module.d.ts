/**
 * Ambient typing for the untyped `pg` package.
 *
 * `pg` (node-postgres) ships no type declarations and there is no
 * `@types/pg` in this package's dependency closure, so a direct
 * `import('pg')` would otherwise be an implicit-`any` module under
 * `noImplicitAny`. This declaration types only the slice the driver glue
 * consumes: the `Pool` constructor for the writing pool and the `Client`
 * constructor for the dedicated signal-listener connection, both reached
 * through the CJS default export.
 *
 * Both constructor shapes come from the shared {@link PostgresDriverModule},
 * so this declaration never restates them — the pool surface is not widened
 * beyond what the driver glue and the signal capability actually use.
 *
 * Internal ambient typing only — it is never part of the published declaration
 * surface, which keeps its self-owned structural `PostgresPoolLike` /
 * `PostgresSignalClientLike` shapes and never references `import('pg')`.
 */
declare module 'pg' {
  import type { PostgresDriverModule } from './pg-signal-client.js';

  /** node-postgres connection pool constructor. */
  const Pool: PostgresDriverModule['Pool'];
  /** node-postgres dedicated single-connection client constructor. */
  const Client: PostgresDriverModule['Client'];

  /** CJS default export carrying the package's public members. */
  const pg: { Pool: typeof Pool; Client: typeof Client };
  export default pg;
  export { Pool, Client };
}
