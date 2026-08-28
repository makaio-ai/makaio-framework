import { z } from 'zod';
import type {
  AndCondition,
  Condition,
  ExpressionCondition,
  FieldCondition,
  FieldOperator,
  JsonObject,
  JsonObjectShape,
  JsonValue,
  NotCondition,
  OrCondition,
  Rule,
  RuleSetOptions,
  ScalarValue,
} from './types.js';

/**
 * Zod schema for JSON numbers used across scalar values, metadata, and priority.
 * The rules contract follows the repo's JSON convention and accepts only finite numbers.
 */
const JsonNumberSchema = z.number().finite();

export const ScalarValueSchema: z.ZodType<ScalarValue> = z.union([z.string(), JsonNumberSchema, z.boolean(), z.null()]);

/**
 * Zod schema for JSON values stored inside rules and actions.
 */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    JsonNumberSchema,
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/**
 * Zod schema for JSON objects stored inside rules and actions.
 */
export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), JsonValueSchema);

/**
 * Zod schema for supported field operators.
 */
export const FieldOperatorSchema: z.ZodType<FieldOperator> = z.union([
  ScalarValueSchema,
  z.object({ $eq: ScalarValueSchema }).strict(),
  z.object({ $ne: ScalarValueSchema }).strict(),
  z.object({ $in: z.array(ScalarValueSchema) }).strict(),
  z.object({ $nin: z.array(ScalarValueSchema) }).strict(),
  z.object({ $contains: ScalarValueSchema }).strict(),
  z.object({ $containsPrefix: z.string() }).strict(),
  z.object({ $exists: z.boolean() }).strict(),
  z.object({ $startsWith: z.string() }).strict(),
  z.object({ $endsWith: z.string() }).strict(),
  z.object({ $glob: z.string() }).strict(),
]);

/**
 * Zod schema for field conditions.
 */
export const FieldConditionSchema: z.ZodType<FieldCondition> = z
  .object({
    field: z.string().min(1),
    operator: FieldOperatorSchema,
  })
  .strict();

/**
 * Zod schema for expression conditions.
 */
export const ExpressionConditionSchema: z.ZodType<ExpressionCondition> = z
  .object({
    $expr: z.string().min(1),
  })
  .strict();

/**
 * Zod schema for any supported condition.
 */
export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    FieldConditionSchema,
    z.object({ $and: z.array(ConditionSchema).min(1) }).strict() as z.ZodType<AndCondition>,
    z.object({ $or: z.array(ConditionSchema).min(1) }).strict() as z.ZodType<OrCondition>,
    z.object({ $not: ConditionSchema }).strict() as z.ZodType<NotCondition>,
    ExpressionConditionSchema,
  ]),
);

/**
 * Zod schema for rule-set evaluation options.
 */
export const RuleSetOptionsSchema: z.ZodType<RuleSetOptions> = z
  .object({
    includeDisabled: z.boolean().optional(),
  })
  .strict();

/**
 * Build a Zod schema for rules with a caller-defined action payload.
 * @param actionSchema - Zod schema describing the action payload
 * @returns Zod schema for the full rule structure
 */
export function RuleSchema<TAction extends JsonObjectShape>(
  actionSchema: z.ZodType<TAction>,
): z.ZodType<Rule<TAction>> {
  return z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      description: z.string().optional(),
      condition: ConditionSchema,
      action: actionSchema,
      priority: JsonNumberSchema,
      enabled: z.boolean(),
      metadata: JsonObjectSchema.optional(),
    })
    .strict();
}
