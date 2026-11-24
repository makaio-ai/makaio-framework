import type { JsonSchema, JsonValue } from '../shared/json-value.js';

/**
 * Context given to the own check (`validate`) of a trigger, a reaction, a
 * lookup or a rule block, and to a lookup's `answer`.
 */
export interface RuleCheckContext {
  /** Context the host forwards from the check of the rule set being validated. */
  readonly catalogContext?: JsonValue;
  /** JSON schema of every root a condition or parameter tree may read, by root name (`$event`, `$lookup`, `$item`). */
  readonly roots: Readonly<Record<string, JsonSchema>>;
}
