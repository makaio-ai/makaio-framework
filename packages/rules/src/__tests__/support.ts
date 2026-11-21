import { evaluate } from '../evaluator.js';
import type { Condition, FieldOperator, Rule } from '../types.js';

/**
 * Evaluate a condition that is expected to evaluate without error.
 * @param condition - Condition tree to evaluate
 * @param context - Context object passed to `evaluate`
 * @returns Whether the condition matched
 * @throws Error naming the path and message when the outcome is an error
 */
export function matched(condition: Condition, context: Record<string, unknown>): boolean {
  const outcome = evaluate(condition, context);
  if ('error' in outcome) {
    throw new Error(`Expected a match result, got an error at '${outcome.error.path}': ${outcome.error.message}`);
  }
  return outcome.matched;
}

/**
 * Evaluate a condition that is expected to fail.
 * @param condition - Condition tree to evaluate
 * @param context - Context object passed to `evaluate`
 * @returns The error of the outcome
 * @throws Error when the outcome is a match result instead of an error
 */
export function errorOf(condition: Condition, context: Record<string, unknown>): { path: string; message: string } {
  const outcome = evaluate(condition, context);
  if (!('error' in outcome)) {
    throw new Error(`Expected an error, got matched: ${String(outcome.matched)}`);
  }
  return outcome.error;
}

/**
 * Evaluate a single top-level field condition (`field: 'x'`) against a context.
 * @param operator - Operator under test
 * @param context - Context object passed to `evaluate`
 * @returns Whether the condition matched
 */
export function fieldMatches(operator: FieldOperator, context: Record<string, unknown>): boolean {
  return matched({ field: 'x', operator }, context);
}

/**
 * Build a minimal rule with a label action.
 * @param id - Rule identifier (also used as name and label)
 * @param condition - Predicate that determines whether the rule matches
 * @param enabled - Whether the rule is active; defaults to true
 * @param priority - Consumer-owned sort hint; defaults to 0
 * @returns Fully typed Rule object
 */
export function makeRule(id: string, condition: Condition, enabled = true, priority = 0): Rule<{ label: string }> {
  return { id, name: id, condition, action: { label: id }, priority, enabled };
}
