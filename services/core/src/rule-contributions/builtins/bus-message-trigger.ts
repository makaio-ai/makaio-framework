import { z } from 'zod';
import type { JsonSchema, JsonValue, SubjectName, SubjectPattern } from '@makaio/contracts';
import type { TriggerContribution } from '@makaio/contracts/rules';
import { JsonValueSchema, SubjectPatternSchema } from '@makaio/contracts';
import { zodSchemaToJsonRecord } from '@makaio/contracts/shared';

/** Canonical kind of the core's generic bus-message trigger. */
export const BUS_MESSAGE_TRIGGER_KIND = 'makaio.bus-message';

/** Fixed parameters of {@link BUS_MESSAGE_TRIGGER_KIND}: the one subject pattern it fires from. */
export const BusMessageTriggerParamsSchema = z
  .object({
    /** Subject pattern this trigger fires from. */
    subject: SubjectPatternSchema,
  })
  .strict();

/** Facts {@link BUS_MESSAGE_TRIGGER_KIND} produces: the raw subject and payload of the occasion. */
const BusMessageFactsSchema = z
  .object({
    /** Subject of the entry or message that caused the occasion. */
    subject: z.string(),
    /** Raw payload, read by path in conditions; not checked against a schema here. */
    payload: JsonValueSchema,
  })
  .strict();

/** Detached JSON Schema of {@link BusMessageFactsSchema}, computed once at module load. */
const BUS_MESSAGE_FACTS_SCHEMA: JsonSchema = zodSchemaToJsonRecord(BusMessageFactsSchema);

/**
 * The core's generic trigger: any recorded entry or received message as a rule
 * occasion, with no translation beyond carrying the subject and raw payload
 * forward as facts.
 *
 * Only a projection: it never calls anything that starts a source, and it
 * fires from events only — never from a request,
 * since a request has exactly one answerer and a trigger must neither delay
 * nor answer one. That "events only" restriction is enforced by whichever
 * caller feeds this trigger journal entries and received messages, not by
 * this contribution, whose `toFacts` only sees `{ subject, payload }`.
 */
export const busMessageTrigger: TriggerContribution = {
  kind: BUS_MESSAGE_TRIGGER_KIND,
  description: 'Fires from a recorded entry or a received message matching one bus subject pattern.',
  params: BusMessageTriggerParamsSchema,

  subjects(params: JsonValue | undefined): SubjectPattern[] {
    if (params === undefined) return [];
    const { subject } = BusMessageTriggerParamsSchema.parse(params);
    return [subject];
  },

  facts(): JsonSchema {
    return BUS_MESSAGE_FACTS_SCHEMA;
  },

  toFacts(message: { readonly subject: SubjectName; readonly payload: JsonValue }): Record<string, JsonValue> | null {
    return { subject: message.subject, payload: message.payload };
  },
};
