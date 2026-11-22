import { z } from 'zod';
import { CallContextRecordSchema, ContributionNameSchema, ExtensionNameSchema } from '@makaio/core';
import { JsonValueSchema } from '../shared/json-value.js';
import { EntryIdSchema, PositionSchema, SubjectNameSchema } from './identifiers.js';
import { WitnessedAccountSchema } from './witnessed-account.js';

/**
 * Where a journal entry came from: the call context under which it was
 * recorded, extended with the recording extension, the inbound edge that
 * accepted it and the witnessed account named by that edge.
 *
 * The caller is the recording extension and the principal comes from the
 * context of the recording code or from the witnessed account; both are set by
 * the journal, never by the recording code.
 */
export const OriginSchema = CallContextRecordSchema.extend({
  /** The extension that recorded the entry; it owns the subject. */
  extension: ExtensionNameSchema,
  /** The inbound edge that accepted the entry, when it came in through an edge. */
  edge: ContributionNameSchema.optional(),
  /** The witnessed account of an external system, as the edge stated it. It stays after any mapping to a party. */
  witnessed: WitnessedAccountSchema.optional(),
}).strict();
/** Where a journal entry came from. */
export type Origin = z.infer<typeof OriginSchema>;

/**
 * One recorded event in the journal, in its durable form. It is unrelated to
 * the transient `ObservedBusMessage` of the bus.
 *
 * An entry never changes after it was written.
 */
export const JournalEntrySchema = z
  .object({
    /** Identifier of the entry. */
    entryId: EntryIdSchema,
    /** Ordinal of the entry over the whole journal. */
    position: PositionSchema,
    /** Name of the event the entry records. */
    subject: SubjectNameSchema,
    /** Payload, checked against the schema of the subject when it was recorded. */
    payload: JsonValueSchema,
    /** Version of the subject's schema at the time of recording. */
    schemaVersion: z.string().min(1),
    /** Key against duplicates, unique per extension. */
    key: z.string().min(1),
    /** Key that fixes the order among entries, when the recorder gave one. */
    orderKey: z.string().optional(),
    /** Where the entry came from. */
    origin: OriginSchema,
    /** When the entry was recorded, as an ISO date-time. */
    recordedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
/** One recorded event in the journal, in its durable form. */
export type JournalEntry = z.infer<typeof JournalEntrySchema>;
