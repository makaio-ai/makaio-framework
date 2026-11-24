import { z } from 'zod';
import { ContributionNameSchema, ExtensionNameSchema } from '@makaio/core';
import { ConditionSchema } from '../shared/condition.js';
import type { Condition } from '../shared/condition.js';
import { JsonValueSchema } from '../shared/json-value.js';
import type { JsonValue } from '../shared/json-value.js';
import { FactPathSchema } from './fact-path.js';
import type { FactPath } from './fact-path.js';
import { RuleIdSchema } from './identifiers.js';
import type { ReactionKind, RuleId, StrategyKind, TriggerKind } from './identifiers.js';
import { LookupCallSchema } from './lookup-call.js';
import type { LookupCall } from './lookup-call.js';
import { ParamTreeSchema } from './param-tree.js';
import type { ParamTree } from './param-tree.js';

/**
 * A rule the way a host declares it: which trigger opens it, what it checks
 * and resolves, and what it runs when it matches.
 *
 * The form is generic; a host extends it through rule blocks under the name
 * of an extension (`extensions`), without the core knowing the meaning of a
 * block. Group, priority, "not switchable off" and the reach of stopping are
 * core fields because the evaluation reads them.
 *
 * Named `ReactionRule` because `@makaio/rules` already owns the name `Rule`.
 */
export interface ReactionRule {
  /** Identifier of the rule. */
  readonly id: RuleId;
  /** Human-readable description of the rule. */
  readonly description: string;
  /** The one trigger that opens an occasion for this rule. */
  readonly on: { readonly kind: TriggerKind; readonly params?: JsonValue };
  /** Lookups resolved in this order before `when` is checked. */
  readonly lookups?: readonly LookupCall[];
  /** Condition checked against `$event` and `$lookup`. */
  readonly when?: Condition;
  /** Path to a list; the reaction runs once per element. */
  readonly each?: FactPath;
  /** The one reaction this rule runs when it matches. */
  readonly reaction: { readonly kind: ReactionKind; readonly params?: Readonly<Record<string, ParamTree>> };
  /** Name of the group this rule belongs to; absent means independent. */
  readonly group?: string;
  /** Mandatory inside a group, forbidden otherwise; higher number decided first. */
  readonly priority?: number;
  /** Not switchable off: ignores every stop, and cannot be excluded. */
  readonly mandatory?: true;
  /** Reach of stopping on a match. */
  readonly stop?: 'group' | 'event';
  /** Rule blocks, one key per extension. */
  readonly extensions?: Readonly<Record<string, JsonValue>>;
}

/**
 * Zod schema for {@link ReactionRule}.
 */
export const ReactionRuleSchema: z.ZodType<ReactionRule> = z
  .object({
    id: RuleIdSchema,
    description: z.string(),
    on: z.object({ kind: ContributionNameSchema, params: JsonValueSchema.optional() }).strict(),
    lookups: z.array(LookupCallSchema).optional(),
    when: ConditionSchema.optional(),
    each: FactPathSchema.optional(),
    reaction: z
      .object({ kind: ContributionNameSchema, params: z.record(z.string(), ParamTreeSchema).optional() })
      .strict(),
    group: z.string().optional(),
    priority: z.number().optional(),
    mandatory: z.literal(true).optional(),
    stop: z.enum(['group', 'event']).optional(),
    extensions: z.record(ExtensionNameSchema, JsonValueSchema).optional(),
  })
  .strict();

/**
 * A group of rules, as the host's rule source names it.
 */
export interface RuleGroup {
  /** Name of the group. */
  readonly group: string;
  /** Strategy that decides the group, contributed by an extension. */
  readonly strategy: StrategyKind;
}

/**
 * Zod schema for {@link RuleGroup}.
 */
export const RuleGroupSchema: z.ZodType<RuleGroup> = z
  .object({
    group: z.string(),
    strategy: ContributionNameSchema,
  })
  .strict();

/**
 * A named exclusion, as the host's rule source names it.
 */
export interface RuleExclusion {
  /** Identifier of the excluded rule. */
  readonly ruleId: RuleId;
  /** Who caused the exclusion, open text of the host (who excluded, where). */
  readonly by: string;
  /**
   * The excluded rule, as the rule source knew it before the exclusion.
   * `null` means the rule source knows no rule of this name.
   */
  readonly rule: ReactionRule | null;
}

/**
 * Zod schema for {@link RuleExclusion}.
 */
export const RuleExclusionSchema: z.ZodType<RuleExclusion> = z
  .object({
    ruleId: RuleIdSchema,
    by: z.string(),
    rule: ReactionRuleSchema.nullable(),
  })
  .strict();
