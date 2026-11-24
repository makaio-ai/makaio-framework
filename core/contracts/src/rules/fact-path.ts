import { z } from 'zod';

/**
 * Zod schema for {@link FactPath}.
 */
export const FactPathSchema = z.string().min(1);

/**
 * Dot-notation path into the facts of an occasion, for example
 * `$event.facts.payload.action`. The root names `$event`, `$lookup` and,
 * only in values and only with `each`, `$item` select which tree the path
 * reads from.
 */
export type FactPath = z.infer<typeof FactPathSchema>;
