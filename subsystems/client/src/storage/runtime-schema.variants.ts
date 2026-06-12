/**
 * Dialect variants for the `client_runtimes` storage tables.
 * @packageDocumentation
 */

import { defineDialectSchema } from '@makaio/storage-drizzle';
import { clientRuntimes } from './runtime-schema.js';
import { clientRuntimes as clientRuntimesPg } from './runtime-schema.postgres.js';

/** Dialect variants for the client runtimes storage tables. */
export const clientRuntimesSchema = defineDialectSchema({ clientRuntimes }, { clientRuntimes: clientRuntimesPg });
