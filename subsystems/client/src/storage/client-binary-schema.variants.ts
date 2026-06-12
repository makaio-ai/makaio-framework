/**
 * Dialect variants for the client binary installation state tables.
 * @packageDocumentation
 */

import { defineDialectSchema } from '@makaio/storage-drizzle';
import { clientBinaryVersions, clientBinaryState } from './client-binary-schema.js';
import {
  clientBinaryVersions as clientBinaryVersionsPg,
  clientBinaryState as clientBinaryStatePg,
} from './client-binary-schema.postgres.js';

/** Dialect variants for the client binary schema tables. */
export const clientBinarySchema = defineDialectSchema(
  { clientBinaryVersions, clientBinaryState },
  { clientBinaryVersions: clientBinaryVersionsPg, clientBinaryState: clientBinaryStatePg },
);
