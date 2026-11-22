import { z } from 'zod';
import { ContributionNameSchema } from '@makaio/core';
import type { CallContext, ContributionName, PartyKind } from '@makaio/core';
import type { JsonSchema, JsonValue } from '../shared/json-value.js';

/**
 * Name of a right: a declared, granular right under the name of an extension
 * (for example `makaio.subject.send`). The core knows no meaning of it.
 */
export type RightName = ContributionName;

/**
 * A right as an extension declares it.
 */
export interface RightContribution {
  /** Name of the right, owned by the declaring extension. */
  readonly right: RightName;
  /** What the right allows, for people. */
  readonly description: string;
  /** JSON schema of the context of a question about this right. */
  readonly context: JsonSchema;
  /** Suggestion from code for which kinds of parties the right is meant. It grants nothing. */
  readonly suggestedFor?: readonly PartyKind[];
}

/**
 * Answer to a question about a right: granted, or denied with a reason and,
 * when known, the answer source that denied.
 */
export const RightAnswerSchema = z.discriminatedUnion('granted', [
  z
    .object({
      /** The right is granted. */
      granted: z.literal(true),
    })
    .strict(),
  z
    .object({
      /** The right is denied. */
      granted: z.literal(false),
      /** Why the right is denied. */
      reason: z.string(),
      /** The answer source that denied. */
      by: ContributionNameSchema.optional(),
    })
    .strict(),
]);
/** Answer to a question about a right. */
export type RightAnswer = z.infer<typeof RightAnswerSchema>;

/**
 * A question about one right, as the core builds it for the answer sources.
 */
export interface RightQuestion {
  /** Context of the call: caller, principal and attesting party. Set by the core. */
  readonly call: CallContext;
  /** The right that is asked about. */
  readonly right: RightName;
  /** Context of the question; it follows the schema of the right. */
  readonly context: JsonValue;
}

/**
 * An answer source as an extension contributes it: answers questions about the
 * rights its patterns cover.
 */
export interface RightsSourceContribution {
  /** Name of the answer source, owned by the contributing extension. */
  readonly source: ContributionName;
  /** What the source decides, for people. */
  readonly description: string;
  /** Patterns over names of rights the source answers for (for example `makaio.subject.*`). */
  readonly rights: readonly string[];
  /**
   * The patterns from `rights` whose answer does not depend on the payload in
   * the context. Only answers to these rights are cached by the core; absent
   * means every answer counts as payload-dependent and is not cached.
   */
  readonly payloadIndependent?: readonly string[];
  /**
   * Answers a question inside the host process from the source's own content.
   * It must not send a message whose check would ask for rights again.
   * @param question - The question to answer.
   * @returns The answer of this source.
   */
  answer(question: RightQuestion): Promise<RightAnswer>;
}
