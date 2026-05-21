import { z } from 'zod';
import { localSubject } from './utils/local-schema.js';

/** Payload emitted when a transport establishes or re-establishes a connection. */
export type ConnectedPayload = { transport: string };

/** Payload emitted when a transport loses connection unexpectedly. */
export type DisconnectedPayload = { transport: string };

/**
 * Schema definitions for bus-level lifecycle events.
 *
 * Kept in a separate file from `lifecycle.ts` so that `bus.ts` can import
 * these schemas without creating a circular dependency:
 * `bus.ts → lifecycle-schemas.ts` (no further deps)
 * `lifecycle.ts → lifecycle-schemas.ts` + `bus.ts` (unidirectional)
 */
export const LifecycleSchemas = {
  connected: localSubject(z.object({ transport: z.string() })),
  disconnected: localSubject(z.object({ transport: z.string() })),
};
