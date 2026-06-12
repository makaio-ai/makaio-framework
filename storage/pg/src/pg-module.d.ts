/**
 * Ambient typing for the untyped `pg` package.
 *
 * `pg` (node-postgres) ships no type declarations and there is no
 * `@types/pg` in this package's dependency closure, so a direct
 * `import('pg')` would otherwise be an implicit-`any` module under
 * `noImplicitAny`. This declaration types only the slice the driver glue
 * consumes (the `Pool` constructor reached through the CJS default export).
 *
 * Internal ambient typing only — it is never part of the published declaration
 * surface, which keeps its self-owned structural `PostgresPoolLike` shape and
 * never references `import('pg')`.
 */
declare module 'pg' {
  import type { PostgresPoolLike } from './raw-sql.js';

  /** node-postgres connection pool constructor. */
  const Pool: new (config: { connectionString: string; max: number }) => PostgresPoolLike;

  /** CJS default export carrying the package's public members. */
  const pg: { Pool: typeof Pool };
  export default pg;
  export { Pool };
}
