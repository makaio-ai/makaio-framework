import { z } from 'zod';
import { type JsonValue, JsonValueSchema } from './json-value.js';

/**
 * Scalar operand of the membership and string operators.
 */
export type ConditionScalarValue = string | number | boolean | null;

/**
 * Leaf-level comparison against a single field value.
 *
 * A bare scalar is shorthand for `{ $eq: scalar }`.
 *
 * A field is absent when its dot-notation path does not resolve. A field whose value is
 * `null` counts as present.
 *
 * Result per operator, and on an absent field:
 * - `$eq` — the field value equals the operand; any JSON value can be compared. Absent: no match.
 * - `$ne` — the field value does not equal the operand; any JSON value can be compared. Absent: match.
 * - `$in` — the field value is one of the listed scalars. Absent: no match.
 * - `$nin` — the field value is none of the listed scalars. Absent: match.
 * - `$contains` — the field value contains the scalar. Absent: no match.
 * - `$containsPrefix` — the field value contains an entry that starts with the operand.
 *   Absent: no match.
 * - `$exists` — `true` matches a present field, `false` matches an absent field.
 * - `$startsWith` — the field is a string that starts with the operand. Absent: no match.
 * - `$endsWith` — the field is a string that ends with the operand. Absent: no match.
 * - `$glob` — the field is a string that matches the glob pattern. Absent: no match.
 * - `$lt`, `$lte`, `$gt`, `$gte` — ordered comparison of two numbers, or of two RFC 3339
 *   date-time strings. Any other pairing of field value and operand does not match.
 *   Absent: no match.
 * - `$empty` — a value is empty when it is `''`, `[]`, `{}` or `null`; `true` matches an empty
 *   value, `false` matches a non-empty value. Absent: no match, for `$empty: false` as well.
 */
export type FieldOperator =
  | ConditionScalarValue
  | { $eq: JsonValue }
  | { $ne: JsonValue }
  | { $in: ConditionScalarValue[] }
  | { $nin: ConditionScalarValue[] }
  | { $contains: ConditionScalarValue }
  | { $containsPrefix: string }
  | { $exists: boolean }
  | { $startsWith: string }
  | { $endsWith: string }
  | { $glob: string }
  | { $lt: number | string }
  | { $lte: number | string }
  | { $gt: number | string }
  | { $gte: number | string }
  | { $empty: boolean };

/**
 * A single field comparison against the evaluation context.
 */
export interface FieldCondition {
  /** Dot-notation path into the evaluation context, for example `order.state`. */
  field: string;
  /** Comparison to perform against the resolved field value. */
  operator: FieldOperator;
}

/**
 * Boolean AND across multiple child conditions.
 */
export interface AndCondition {
  /** Child conditions that must all match. */
  $and: Condition[];
}

/**
 * Boolean OR across multiple child conditions.
 */
export interface OrCondition {
  /** Child conditions where any matching child matches. */
  $or: Condition[];
}

/**
 * Boolean negation of a child condition.
 */
export interface NotCondition {
  /** Child condition to negate. */
  $not: Condition;
}

/**
 * Jexl-backed expression condition evaluated against the full context.
 */
export interface ExpressionCondition {
  /** Expression string evaluated against the full context object. */
  $expr: string;
}

/** Compound: combines child conditions with boolean logic. */
export type CompoundCondition = AndCondition | OrCondition | NotCondition;

/**
 * Any supported condition.
 */
// Expanded inline rather than using CompoundCondition: the union is identical after
// TypeScript flattens it, and both types live in this file.
export type Condition = FieldCondition | AndCondition | OrCondition | NotCondition | ExpressionCondition;

/**
 * JSON number schema. Conditions accept only finite numbers.
 */
const FiniteNumberSchema = z.number().finite();

/**
 * Operand schema of the ordered comparison operators `$lt`, `$lte`, `$gt`, `$gte`.
 */
const OrderedOperandSchema = z.union([FiniteNumberSchema, z.string().min(1)]);

/**
 * Zod schema for {@link ConditionScalarValue}.
 */
export const ConditionScalarValueSchema: z.ZodType<ConditionScalarValue> = z.union([
  z.string(),
  FiniteNumberSchema,
  z.boolean(),
  z.null(),
]);

/**
 * Zod schema for {@link FieldOperator}. Every operator object is strict and carries exactly
 * one key.
 */
export const FieldOperatorSchema: z.ZodType<FieldOperator> = z.union([
  ConditionScalarValueSchema,
  z.object({ $eq: JsonValueSchema }).strict(),
  z.object({ $ne: JsonValueSchema }).strict(),
  z.object({ $in: z.array(ConditionScalarValueSchema) }).strict(),
  z.object({ $nin: z.array(ConditionScalarValueSchema) }).strict(),
  z.object({ $contains: ConditionScalarValueSchema }).strict(),
  z.object({ $containsPrefix: z.string() }).strict(),
  z.object({ $exists: z.boolean() }).strict(),
  z.object({ $startsWith: z.string() }).strict(),
  z.object({ $endsWith: z.string() }).strict(),
  z.object({ $glob: z.string() }).strict(),
  z.object({ $lt: OrderedOperandSchema }).strict(),
  z.object({ $lte: OrderedOperandSchema }).strict(),
  z.object({ $gt: OrderedOperandSchema }).strict(),
  z.object({ $gte: OrderedOperandSchema }).strict(),
  z.object({ $empty: z.boolean() }).strict(),
]);

/**
 * Zod schema for {@link FieldCondition}.
 */
export const FieldConditionSchema: z.ZodType<FieldCondition> = z
  .object({
    field: z.string().min(1),
    operator: FieldOperatorSchema,
  })
  .strict();

/**
 * Zod schema for {@link ExpressionCondition}.
 */
export const ExpressionConditionSchema: z.ZodType<ExpressionCondition> = z
  .object({
    $expr: z.string().min(1),
  })
  .strict();

/**
 * Zod schema for any {@link Condition}. `$and` and `$or` require at least one child.
 */
export const ConditionSchema: z.ZodType<Condition> = z.lazy(
  (): z.ZodType<Condition> =>
    z.union([
      FieldConditionSchema,
      z.object({ $and: z.array(ConditionSchema).min(1) }).strict(),
      z.object({ $or: z.array(ConditionSchema).min(1) }).strict(),
      z.object({ $not: ConditionSchema }).strict(),
      ExpressionConditionSchema,
    ]),
);

/**
 * Why a condition could not be evaluated. `path` locates the failing node in the condition
 * tree (root is `''`, for example `$and[1].$not.$expr`).
 */
export const ConditionErrorSchema = z.object({ path: z.string(), message: z.string() }).strict();

/** @see {@link ConditionErrorSchema} */
export type ConditionError = z.infer<typeof ConditionErrorSchema>;

/**
 * Result of evaluating a condition. Evaluation never throws.
 *
 * `matched` reports whether the condition holds. `error` reports that it could not be
 * evaluated; `path` locates the failing node in the condition tree (root is `''`, for example
 * `$and[1].$not.$expr`). An error is never a non-match: under `$not` it stays an error.
 */
export const ConditionOutcomeSchema = z.union([
  z.object({ matched: z.boolean() }).strict(),
  z.object({ error: ConditionErrorSchema }).strict(),
]);

/** @see {@link ConditionOutcomeSchema} */
export type ConditionOutcome = z.infer<typeof ConditionOutcomeSchema>;

/**
 * One result of checking a condition before it is activated.
 *
 * `path` locates the node in the condition tree, written like `ConditionOutcome` error paths.
 */
export const ConditionFindingSchema = z
  .object({
    severity: z.enum(['error', 'warning']),
    code: z.string(),
    path: z.string(),
    message: z.string(),
  })
  .strict();

/** @see {@link ConditionFindingSchema} */
export type ConditionFinding = z.infer<typeof ConditionFindingSchema>;
