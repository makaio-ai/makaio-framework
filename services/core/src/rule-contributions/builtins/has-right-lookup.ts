import { z } from 'zod';
import type { CallContext } from '@makaio/core';
import { ContributionNameSchema } from '@makaio/core';
import type { JsonSchema, JsonValue } from '@makaio/contracts';
import type { LookupContribution } from '@makaio/contracts/rules';
import { JsonValueSchema } from '@makaio/contracts';
import { zodSchemaToJsonRecord } from '@makaio/contracts/shared';
import { RightDenialReason, type RightsCapability } from '@makaio/contracts/rights';

/** Canonical kind of the core's "resolve one right" lookup. */
export const HAS_RIGHT_LOOKUP_KIND = 'makaio.has-right';

/** Resolved arguments of {@link HAS_RIGHT_LOOKUP_KIND}. */
export const HasRightLookupArgsSchema = z
  .object({
    /** The right that is asked about. */
    right: ContributionNameSchema,
    /** Context of the question; follows the JSON schema of the right. */
    context: JsonValueSchema.optional(),
  })
  .strict();

/** Answer of {@link HAS_RIGHT_LOOKUP_KIND}: whether the right was granted, and why not when it was not. */
const HasRightAnswerSchema = z
  .object({
    /** Whether the right was granted. */
    granted: z.boolean(),
    /** Why the right was denied; absent when granted. */
    reason: z.string().optional(),
  })
  .strict();

/** Detached JSON Schema of {@link HasRightAnswerSchema}, computed once at module load. */
const HAS_RIGHT_ANSWER_SCHEMA: JsonSchema = zodSchemaToJsonRecord(HasRightAnswerSchema);

/**
 * Builds the core rights lookup using the host's rights resolver.
 * @param resolveRight - Resolves a question for the supplied call.
 * @returns The lookup contribution.
 */
export function createHasRightLookup(resolveRight: RightsCapability['resolve']): LookupContribution {
  return {
    kind: HAS_RIGHT_LOOKUP_KIND,
    description: "Resolves one right for the occasion's principal through the one rights resolution place.",
    args: HasRightLookupArgsSchema,

    answer(): JsonSchema {
      return HAS_RIGHT_ANSWER_SCHEMA;
    },

    async resolve(call: CallContext, args: Record<string, JsonValue>): Promise<JsonValue> {
      const { right, context } = HasRightLookupArgsSchema.parse(args);
      const answer = await resolveRight(call, { right, context: context ?? null });
      if (answer.granted) return { granted: true };
      if (answer.reason === RightDenialReason.sourceUnavailable) {
        throw new Error(`makaio.has-right: denied with reason 'source-unavailable' for right '${right}'`);
      }
      return { granted: false, reason: answer.reason };
    },
  };
}
