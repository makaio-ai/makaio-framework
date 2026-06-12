import { defineDialectSchema } from '@makaio/storage-drizzle';
import { sessionEvents } from './schema.js';
import { sessionEvents as sessionEventsPg } from './schema.postgres.js';

/** Dialect variants for the session events table. */
export const sessionEventsSchema = defineDialectSchema({ sessionEvents }, { sessionEvents: sessionEventsPg });
