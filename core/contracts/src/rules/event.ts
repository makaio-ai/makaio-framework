import { z } from 'zod';
import { CallContextRecordSchema } from '@makaio/core';
import { JsonValueSchema } from '../shared/json-value.js';
import { EntryIdSchema, PositionSchema, SubjectNameSchema } from '../journal/identifiers.js';
import { OriginSchema } from '../journal/entry.js';

/**
 * What caused the occasion that opened an evaluation: a position in the
 * journal, or the receipt of a volatile message.
 */
export const EventFactsCauseSchema = z.union([
  z
    .object({
      entryId: EntryIdSchema,
      position: PositionSchema,
    })
    .strict(),
  z
    .object({
      message: z.object({ receivedAt: z.iso.datetime({ offset: true }) }).strict(),
    })
    .strict(),
]);
/** @see {@link EventFactsCauseSchema} */
export type EventFactsCause = z.infer<typeof EventFactsCauseSchema>;

/**
 * Root `$event` of a rule: what an occasion looked like when a trigger fired.
 *
 * `origin` is the recorded `Origin` for a journal entry, or the plain record
 * of the sending call context for a volatile message.
 */
export const EventFactsSchema = z
  .object({
    /** What caused the occasion. */
    cause: EventFactsCauseSchema,
    /** Subject of the entry or message that caused the occasion. */
    subject: SubjectNameSchema,
    /** Where the occasion came from. */
    origin: z.union([OriginSchema, CallContextRecordSchema]),
    /** Facts, following the facts schema of the trigger that fired. */
    facts: z.record(z.string(), JsonValueSchema),
  })
  .strict();
/** @see {@link EventFactsSchema} */
export type EventFacts = z.infer<typeof EventFactsSchema>;
