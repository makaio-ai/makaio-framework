/**
 * This internal entry has no stability guarantee and is only for adapters that must write in the host's transaction without opening or closing it.
 * @packageDocumentation
 */

export { getPostgresHostTransactionSession } from '../host-database';
