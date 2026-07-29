/**
 * `@makaio/subsystem-workflow-engine/testing/sqlite`
 *
 * The transactional SQLite realization of the durable execution attempt port.
 *
 * It sits on its own subpath rather than on `../testing` because reaching it
 * evaluates `drizzle-orm` and the storage package behind it. Most suites want
 * only the in-memory double, and a barrel that carried both would make every
 * one of them pay for a database driver they never call.
 *
 * Use it when a test must prove that fencing survives real concurrency,
 * serialization, and two independent connections. It is test support, never
 * production persistence: its tables carry a `test_` prefix, it provisions
 * them itself, and it takes no part in any migration chain.
 * @packageDocumentation
 */

export { createSqliteAttemptRepository } from './sqlite-attempt-repository.js';
