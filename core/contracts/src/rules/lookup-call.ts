import { z } from 'zod';
import { ContributionNameSchema } from '@makaio/core';
import { ConditionTemplateSchema, ParamTreeSchema } from './param-tree.js';
import type { ConditionTemplate, ParamTree } from './param-tree.js';
import type { LookupKind } from './identifiers.js';

/**
 * One lookup a rule resolves before its condition and parameters are built.
 *
 * Lookups are resolved in the order they are listed; `args` may read `$event`
 * and any lookup named earlier in the same list.
 */
export interface LookupCall {
  /** Name this lookup's answer is reachable under, as `$lookup.<name>`. */
  readonly name: string;
  /** Kind of lookup to call. */
  readonly lookup: LookupKind;
  /** Arguments, resolved against `$event` and earlier lookups before the call. */
  readonly args: Readonly<Record<string, ParamTree>>;
  /**
   * Condition applied in memory to each element of the lookup's answer, after
   * the parts containing `$expr` are stripped and sent to the lookup itself.
   * Only a lookup kind that accepts `where` may carry one; such a kind always
   * answers with a list.
   */
  readonly where?: ConditionTemplate;
}

/**
 * Zod schema for {@link LookupCall}.
 */
export const LookupCallSchema: z.ZodType<LookupCall> = z
  .object({
    name: z.string().min(1),
    lookup: ContributionNameSchema,
    args: z.record(z.string(), ParamTreeSchema),
    where: ConditionTemplateSchema.optional(),
  })
  .strict();
