/**
 * Delivery metadata of recorded events: what the core attaches to a message
 * when it delivers an event that was recorded in the journal.
 */

import { z } from 'zod';
import type { ContributionName } from './names.js';

/**
 * Metadata carried by a message the core delivers to subscribers for a recorded event.
 *
 * The fields are declared here directly because the bus core must not depend on the journal contract; the
 * journal contract checks that they stay assignable to its own identifier types.
 */
export const BusDeliveryMetadataSchema = z
  .object({
    /** Identifier of the journal entry the delivery stems from. */
    entryId: z.string().min(1),
    /** Ordinal of that entry over the whole journal. */
    position: z.number().int().nonnegative(),
  })
  .strict();

/** Metadata carried by a message the core delivers to subscribers for a recorded event. */
export type BusDeliveryMetadata = z.infer<typeof BusDeliveryMetadataSchema>;

/**
 * Name of the core's own reader that delivers recorded events to bus subscribers.
 */
export const MAKAIO_BUS_DELIVERY_READER = 'makaio.bus-delivery' satisfies ContributionName;
