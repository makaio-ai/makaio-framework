/**
 * Dialect variants for the `client_profiles` storage tables.
 * @packageDocumentation
 */

import { defineDialectSchema } from '@makaio/storage-drizzle';
import { clientProfiles } from './profile-schema.js';
import { clientProfiles as clientProfilesPg } from './profile-schema.postgres.js';

/** Dialect variants for the client profiles storage tables. */
export const clientProfilesSchema = defineDialectSchema({ clientProfiles }, { clientProfiles: clientProfilesPg });
