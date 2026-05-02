/**
 * JSON primitive value supported by serialized rules.
 */
export type JsonPrimitive = string | number | boolean | null;

/**
 * JSON object supported by serialized rules.
 */
export interface JsonObject {
  [key: string]: JsonValue;
}

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
 * JSON value supported by serialized rules.
 */
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

/**
 * Scalar comparison value supported by field operators.
 */
export type ScalarValue = JsonPrimitive;

/**
 * Leaf-level comparison against a single field value.
 *
 * Operator payloads are intentionally scalar-only for compatibility with the
 * existing payload filter semantics.
 */
export type FieldOperator =
  | ScalarValue
  | { $eq: ScalarValue }
  | { $ne: ScalarValue }
  | { $in: ScalarValue[] }
  | { $nin: ScalarValue[] }
  | { $exists: boolean }
  | { $startsWith: string }
  | { $endsWith: string }
  | { $glob: string };

/**
 * A single field comparison against the evaluation context.
 */
export interface FieldCondition {
  /** Dot-notation path into the evaluation context. */
  field: string;
  /** Comparison to perform against the resolved field value. */
  operator: FieldOperator;
}

/**
 * Boolean AND across multiple child conditions.
 */
export interface AndCondition {
  /** Child conditions that must all evaluate truthy. */
  $and: Condition[];
}

/**
 * Boolean OR across multiple child conditions.
 */
export interface OrCondition {
  /** Child conditions where any truthy child matches. */
  $or: Condition[];
}

/**
 * Boolean negation of a child condition.
 */
export interface NotCondition {
  /** Child condition to negate. */
  $not: Condition;
}

/** Compound: combines child conditions with boolean logic. */
export type CompoundCondition = AndCondition | OrCondition | NotCondition;

/**
 * Jexl-backed expression condition evaluated against the full context.
 */
export interface ExpressionCondition {
  /** Expression string evaluated against the full context object. */
  $expr: string;
}

/**
 * Any condition supported by the rules engine.
 */
// Expanded inline rather than using CompoundCondition — the union is
// identical after TypeScript flattens it, and both types live in this file.
export type Condition = FieldCondition | AndCondition | OrCondition | NotCondition | ExpressionCondition;

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
  metadata?: JsonObject;
}

/**
 * Options controlling `evaluateRules`.
 */
export interface RuleSetOptions {
  /** Whether disabled rules should still be evaluated. */
  includeDisabled?: boolean;
}
