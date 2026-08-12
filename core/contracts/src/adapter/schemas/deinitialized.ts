import { z } from 'zod';
import { BaseAdapterEventSchema } from './base-event.js';

/** Exact adapter identity withdrawn from routing when its runtime removes the instance. */
export const DeinitializedSchema = BaseAdapterEventSchema.extend({
  /** Machine that hosted the withdrawn instance. */
  machineId: z.string(),
  /** Exact ownership-authority incarnation that hosted the withdrawn instance. */
  ownerInstanceId: z.string(),
});
export type Deinitialized = z.infer<typeof DeinitializedSchema>;
