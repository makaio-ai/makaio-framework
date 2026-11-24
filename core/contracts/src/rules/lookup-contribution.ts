import type { ZodType } from 'zod';
import type { CallContext } from '@makaio/core';
import type { Condition } from '../shared/condition.js';
import type { JsonSchema, JsonValue } from '../shared/json-value.js';
import type { RuleCheckContext } from './check-context.js';
import type { RuleFinding } from './finding.js';
import type { LookupKind } from './identifiers.js';
import type { ParamTree } from './param-tree.js';

/**
 * A lookup as an extension contributes it: reads only, has a deadline, and
 * gives the same answer for the same data.
 */
export interface LookupContribution {
  /** Kind of lookup. */
  readonly kind: LookupKind;
  /** Human-readable description of the lookup. */
  readonly description: string;
  /** Fixed Zod schema of the lookup's arguments. */
  readonly args: ZodType;
  /**
   * JSON schema of the lookup's answer. For a catalog read, undefined
   * arguments ask for the default answer schema.
   * @param args - The lookup's argument tree.
   * @param ctx - Rule check context or host catalog context.
   * @returns JSON schema of the answer.
   */
  answer(args: ParamTree | undefined, ctx: RuleCheckContext): JsonSchema;
  /** Present only for a lookup kind that accepts `where`; such a kind always answers with a list. */
  readonly where?: {
    /**
     * JSON schemas of the roots `where` may read against one element of the answer.
     * @param args - The lookup's argument tree.
     * @param ctx - Check context for the rule set being validated.
     * @returns JSON schema of every root, by root name.
     */
    roots(args: ParamTree, ctx: RuleCheckContext): Record<string, JsonSchema>;
  };
  /**
   * The lookup's own check, run while rules are validated subject to the host's check deadline.
   * @param args - The lookup's argument tree.
   * @param ctx - Check context for the rule set being validated.
   * @returns Findings of the lookup's own check.
   */
  validate?(args: ParamTree, ctx: RuleCheckContext): RuleFinding[] | Promise<RuleFinding[]>;
  /**
   * Resolves the lookup.
   * @param call - Context of the evaluation: caller `makaio.rules`, principal
   *   and attesting party of the occasion; when called from host code, the
   *   context the core forwarded to it. A lookup that needs no right never reads it.
   * @param args - Resolved arguments, checked against `args` schema.
   * @param where - The condition without its parts containing `$expr`; a
   *   lookup kind that accepts `where` answers with a list.
   * @param deadline - ISO date-time the lookup must answer by.
   * @returns The lookup's answer, or `null`.
   */
  resolve(
    call: CallContext,
    args: Record<string, JsonValue>,
    where: Condition | undefined,
    deadline: string,
  ): Promise<JsonValue | null>;
}
