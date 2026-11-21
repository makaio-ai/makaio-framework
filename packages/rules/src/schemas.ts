import { ConditionSchema, JsonRecordSchema } from '@makaio/contracts/shared';
import { z } from 'zod';
import type { JsonObjectShape, Rule, RuleSetOptions } from './types.js';

export {
  ConditionSchema,
  ExpressionConditionSchema,
  FieldConditionSchema,
  FieldOperatorSchema,
  JsonValueSchema,
} from '@makaio/contracts/shared';

/**
 * Zod schema for JSON numbers used for rule priority.
 * The rules contract follows the repo's JSON convention and accepts only finite numbers.
 */
const JsonNumberSchema = z.number().finite();

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
      metadata: JsonRecordSchema.optional(),
    })
    .strict();
}
