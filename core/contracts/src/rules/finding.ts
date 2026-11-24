import type { ConditionFinding } from '../shared/condition.js';

/**
 * One result of checking a rule, a group, a rule block or a contribution
 * before it is activated.
 *
 * Named export in its own file, the same four fields as {@link ConditionFinding}
 * (`severity`, `code`, `path`, `message`): rules reuse the one condition
 * language's finding shape rather than declaring a second schema with the
 * same fields.
 */
export type RuleFinding = ConditionFinding;
