import type { Condition, ConditionError, JsonValue } from '@makaio/contracts/shared';

export type {
  AndCondition,
  CompoundCondition,
  Condition,
  ExpressionCondition,
  FieldCondition,
  FieldOperator,
  JsonValue,
  NotCondition,
  OrCondition,
} from '@makaio/contracts/shared';

/**
 * Type-level JSON object shape for rule action payloads.
 *
 * Optional properties in TypeScript are modeled as `value | undefined`, so the
 * action contract allows `undefined` at the type boundary while runtime schemas
 * still enforce concrete JSON values for persisted payloads.
 */
export interface JsonObjectShape {
  [key: string]: JsonValue | undefined;
}

/**
 * Serializable rule evaluated by the engine.
 * @typeParam TAction - Action payload attached to matching rules
 */
export interface Rule<TAction extends JsonObjectShape = JsonObjectShape> {
  /** Stable identifier for the rule. */
  id: string;
  /** Human-readable rule name. */
  name: string;
  /** Optional description for diagnostics or UI display. */
  description?: string;
  /** Predicate tree that decides whether the rule matches. */
  condition: Condition;
  /** Consumer-defined action payload. */
  action: TAction;
  /**
   * Consumer-owned sort metadata.
   *
   * The rules engine does not interpret this field and preserves the caller's
   * input order during `evaluateRules()`. Consumers that care about priority
   * must sort before calling the evaluator.
   */
  priority: number;
  /** Whether the rule is active by default. */
  enabled: boolean;
  /** Optional free-form metadata. */
  metadata?: Record<string, JsonValue>;
}

/**
 * Options controlling `evaluateRules`.
 */
export interface RuleSetOptions {
  /** Whether disabled rules should still be evaluated. */
  includeDisabled?: boolean;
}

/**
 * Result of evaluating a rule set with `evaluateRules`.
 * @typeParam TAction - Action payload attached to the rules
 */
export interface RuleSetOutcome<TAction extends JsonObjectShape> {
  /** Rules whose condition matched, in input order. */
  matched: Rule<TAction>[];
  /** Rules whose condition could not be evaluated, in input order. */
  failed: Array<{ rule: Rule<TAction>; error: ConditionError }>;
}
