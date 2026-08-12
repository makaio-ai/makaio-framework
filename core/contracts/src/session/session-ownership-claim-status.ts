import { z } from 'zod';

/** Lifecycle state of a durable adapter-session ownership claim. */
export const AdapterSessionClaimStatusSchema = z.enum(['held', 'releasing', 'abandoned']);

/** {@inheritDoc AdapterSessionClaimStatusSchema} */
export type AdapterSessionClaimStatus = z.infer<typeof AdapterSessionClaimStatusSchema>;
