import type { ZodType } from 'zod';
import type { JsonValue } from '../shared/json-value.js';
import type { RuleCheckContext } from './check-context.js';
import type { RuleFinding } from './finding.js';
import type { ReactionRule } from './rule.js';

/**
 * A rule block as an extension contributes it: the shape of its own entry
 * under `ReactionRule.extensions[<own name>]`.
 *
 * There is no `extension` field: the kernel knows the contributing extension
 * from the key the block is read under.
 */
export interface RuleBlockContribution {
  /** Fixed Zod schema of the block. */
  readonly schema: ZodType;
  /**
   * The block's own check, run while rules are validated subject to the host's check deadline.
   * @param block - The block's content, already checked against `schema`.
   * @param rule - The rule the block belongs to.
   * @param ctx - Check context for the rule set being validated.
   * @returns Findings of the block's own check.
   */
  validate?(block: JsonValue, rule: ReactionRule, ctx: RuleCheckContext): RuleFinding[] | Promise<RuleFinding[]>;
}
