import { z } from 'zod';
import {
  type ExpressionCondition,
  type FieldOperator,
  ExpressionConditionSchema,
  FieldOperatorSchema,
} from '../shared/condition.js';
import { JsonValueSchema } from '../shared/json-value.js';
import type { JsonValue } from '../shared/json-value.js';
import { isJsonObject } from '../shared/json-tree.js';
import { FactPathSchema } from './fact-path.js';
import type { FactPath } from './fact-path.js';

/**
 * A value resolved before a lookup is called or a reaction's parameters are
 * built: a literal, a reference into the facts of the occasion, or a string
 * template with `{{<FactPath>}}` placeholders.
 */
export type ValueExpr = { readonly literal: JsonValue } | { readonly ref: FactPath } | { readonly template: string };

/**
 * Zod schema for {@link ValueExpr}.
 */
export const ValueExprSchema: z.ZodType<ValueExpr> = z.union([
  z.object({ literal: JsonValueSchema }).strict(),
  z.object({ ref: FactPathSchema }).strict(),
  z.object({ template: z.string() }).strict(),
]);

/** @param value - Unbound operand or parameter node.
 * @returns Whether the object must be interpreted as a value expression.
 */
function isReservedOperand(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    Object.keys(value).length === 1 &&
    (Object.hasOwn(value, 'ref') || Object.hasOwn(value, 'template') || Object.hasOwn(value, 'literal'))
  );
}

/**
 * A tree of parameters for a lookup call or a reaction: a {@link ValueExpr},
 * a plain scalar, or an array or object resolved element by element. A fixed
 * object that looks like a `ValueExpr` must be written under `literal` to be
 * read as one.
 */
export type ParamTree =
  | ValueExpr
  | null
  | boolean
  | number
  | string
  | readonly ParamTree[]
  | { readonly [key: string]: ParamTree };

/**
 * Zod schema for {@link ParamTree}.
 */
export const ParamTreeSchema: z.ZodType<ParamTree> = z.lazy(() =>
  z.union([
    ValueExprSchema,
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(ParamTreeSchema),
    z.record(z.string(), ParamTreeSchema).refine((value) => !isReservedOperand(value)),
  ]),
);

const comparisonOperators = [
  '$eq',
  '$ne',
  '$in',
  '$nin',
  '$contains',
  '$containsPrefix',
  '$exists',
  '$startsWith',
  '$endsWith',
  '$glob',
  '$lt',
  '$lte',
  '$gt',
  '$gte',
  '$empty',
] as const;

/** One comparison with an explicit operand expression. */
type ExpressionComparison = Partial<Record<(typeof comparisonOperators)[number], ValueExpr>>;

/**
 * A lookup filter with the same value expressions as a parameter tree.
 * Single-key `ref`, `template` and `literal` objects are reserved at the
 * operand boundary. After binding, the lookup receives a regular condition.
 */
export type ConditionTemplate =
  | { $and: ConditionTemplate[] }
  | { $or: ConditionTemplate[] }
  | { $not: ConditionTemplate }
  | { field: FactPath; operator: FieldOperator | ExpressionComparison }
  | ExpressionCondition;

const expressionComparisonSchema = z
  .partialRecord(z.enum(comparisonOperators), ValueExprSchema)
  .refine((value) => Object.keys(value).length === 1);

const directOperatorSchema = FieldOperatorSchema.refine(
  (operator) => !isJsonObject(operator) || !isReservedOperand(Object.values(operator)[0]),
  'Single-key ref, template and literal operands are reserved for operand expressions',
);

/** Zod schema for {@link ConditionTemplate}. */
export const ConditionTemplateSchema: z.ZodType<ConditionTemplate> = z.lazy(() =>
  z.union([
    z.object({ $and: z.array(ConditionTemplateSchema) }).strict(),
    z.object({ $or: z.array(ConditionTemplateSchema) }).strict(),
    z.object({ $not: ConditionTemplateSchema }).strict(),
    z.object({ field: FactPathSchema, operator: z.union([directOperatorSchema, expressionComparisonSchema]) }).strict(),
    ExpressionConditionSchema,
  ]),
);
