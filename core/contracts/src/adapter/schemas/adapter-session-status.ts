import { z } from 'zod';

/**
 * Adapter session import lifecycle status.
 *
 * Shared by adapter events and storage contracts so UI/cache consumers observe
 * the same closed set of statuses everywhere.
 */
export const AdapterSessionStatusSchema = z.enum(['discovered', 'imported', 'live', 'tracking']);

export type AdapterSessionStatus = z.infer<typeof AdapterSessionStatusSchema>;
