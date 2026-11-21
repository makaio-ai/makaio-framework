import { z } from 'zod';

/**
 * Ordered step isolation levels, weakest first; the index is the rank.
 *
 * The scale can grow: a later level is inserted at its place in the order.
 * Compare levels with {@link holdsAtLeast}; never branch over a fixed set of
 * levels.
 */
export const ISOLATION_LEVELS = ['process', 'user', 'machine'] as const;

/** Schema of one step isolation level. */
export const IsolationLevelSchema = z.enum(ISOLATION_LEVELS);

/** One step isolation level. */
export type IsolationLevel = z.infer<typeof IsolationLevelSchema>;

/**
 * Whether a declared level guarantees at least the required level.
 * @param declared - Level that is guaranteed.
 * @param required - Level that is required.
 * @returns `true` when `declared` ranks at or above `required`; `false` when
 * either value is not a level of this scale, so an unknown level never
 * satisfies a requirement.
 */
export function holdsAtLeast(declared: IsolationLevel, required: IsolationLevel): boolean {
  const declaredRank = ISOLATION_LEVELS.indexOf(declared);
  const requiredRank = ISOLATION_LEVELS.indexOf(required);
  return declaredRank >= 0 && requiredRank >= 0 && declaredRank >= requiredRank;
}
