import { z } from 'zod';
import { ContributionNameSchema, ExtensionNameSchema } from '@makaio/core';
import { JsonSchemaRecordSchema } from '../shared/json-value.js';
import { JournalEntrySchema } from './entry.js';
import { EntryIdSchema, PositionSchema, SubjectNameSchema, SubjectPatternSchema } from './identifiers.js';
import { ReaderEntryStateSchema } from './reader.js';

/** Page size used when a paged journal request omits `limit`. */
export const JOURNAL_PAGE_DEFAULT_LIMIT = 50;

/** Largest page size a paged journal request may ask for. */
export const JOURNAL_PAGE_MAX_LIMIT = 500;

/**
 * Page size of a paged journal request.
 *
 * Not defaulted here: an absent `limit` means {@link JOURNAL_PAGE_DEFAULT_LIMIT}.
 * A value above {@link JOURNAL_PAGE_MAX_LIMIT} is a schema error, never silently capped.
 */
export const JournalPageLimitSchema = z.number().int().min(1).max(JOURNAL_PAGE_MAX_LIMIT);

/**
 * Request to read recorded entries: either a page of entries of a subject
 * pattern, or exactly one entry by its identifier.
 */
export const JournalEntriesRequestSchema = z.union([
  z
    .object({
      /** Subject pattern in the bus subscription grammar; absent reads every subject the caller may subscribe to. */
      subject: SubjectPatternSchema.optional(),
      /** Position to start at. */
      from: PositionSchema.optional(),
      /** Opaque continuation token of a previous page; when present it takes precedence over `from`. */
      cursor: z.string().min(1).optional(),
      /** Page size; absent means the default limit. */
      limit: JournalPageLimitSchema.optional(),
    })
    .strict(),
  z
    .object({
      /** Identifier of the one entry to read. */
      entryId: EntryIdSchema,
    })
    .strict(),
]);
/** Request to read recorded entries. */
export type JournalEntriesRequest = z.infer<typeof JournalEntriesRequestSchema>;

/** One page of recorded entries. */
export const JournalEntriesPageSchema = z
  .object({
    /** Entries of the page, in journal order. */
    entries: z.array(JournalEntrySchema),
    /** Opaque token for the next page; absent on the last page. */
    nextCursor: z.string().min(1).optional(),
  })
  .strict();
/** One page of recorded entries. */
export type JournalEntriesPage = z.infer<typeof JournalEntriesPageSchema>;

/** Request to read the reading states of one reader in pages. */
export const ReaderStatesRequestSchema = z
  .object({
    /** The reader whose states are read. */
    reader: ContributionNameSchema,
    /** With this set, only the state of that one entry is returned. */
    entryId: EntryIdSchema.optional(),
    /** Restricts the result to states in this state. */
    state: z.enum(['open', 'failed']).optional(),
    /** Position to start at. */
    since: PositionSchema.optional(),
    /** Opaque continuation token of a previous page. */
    cursor: z.string().min(1).optional(),
    /** Page size; absent means the default limit. */
    limit: JournalPageLimitSchema.optional(),
  })
  .strict();
/** Request to read the reading states of one reader. */
export type ReaderStatesRequest = z.infer<typeof ReaderStatesRequestSchema>;

/** One page of reading states. */
export const ReaderStatesPageSchema = z
  .object({
    /** Reading states of the page. */
    states: z.array(ReaderEntryStateSchema),
    /** The reader's stored journal position, even when no entry states match. */
    readerPosition: PositionSchema.optional(),
    /** Opaque token for the next page; absent on the last page. */
    nextCursor: z.string().min(1).optional(),
  })
  .strict();
/** One page of reading states. */
export type ReaderStatesPage = z.infer<typeof ReaderStatesPageSchema>;

/** Request to set the failed reading state of one entry back to open. */
export const JournalReprocessRequestSchema = z
  .object({
    /** The reader whose reading state is reset. */
    reader: ContributionNameSchema,
    /** The entry whose reading state is reset. */
    entryId: EntryIdSchema,
  })
  .strict();
/** Request to reprocess one entry for one reader. */
export type JournalReprocessRequest = z.infer<typeof JournalReprocessRequestSchema>;

/**
 * Outcome of a reprocess request. On success the failed reading state of the entry is set back to open.
 */
export const JournalReprocessResponseSchema = z.discriminatedUnion('success', [
  z
    .object({
      success: z.literal(true),
      /** The reading state was set back to open. */
      status: z.literal('requeued'),
    })
    .strict(),
  z
    .object({
      success: z.literal(false),
      /** `not-found`: the reader has no reading state for the entry. `not-failed`: the reading state is not failed. */
      code: z.enum(['not-found', 'not-failed']),
    })
    .strict(),
]);
/** Outcome of a reprocess request. */
export type JournalReprocessResponse = z.infer<typeof JournalReprocessResponseSchema>;

/** Suggestion for which kinds of parties sending or subscribing a subject is meant; it grants nothing. */
const SuggestedForSchema = z
  .object({
    /** Kinds of parties that are meant to send. */
    send: z.array(ContributionNameSchema).optional(),
    /** Kinds of parties that are meant to subscribe. */
    subscribe: z.array(ContributionNameSchema).optional(),
  })
  .strict();

/** Fields every subject directory entry carries, whatever its type. */
const subjectDirectoryEntryBase = {
  /** The subject name. */
  subject: SubjectNameSchema,
  /** The extension that declares the subject. */
  extension: ExtensionNameSchema,
  /** Human-readable description of the subject. */
  description: z.string(),
  /** Which kinds of parties sending or subscribing is meant; grants nothing. */
  suggestedFor: SuggestedForSchema.optional(),
};

/** Explicit marker for a subject schema that could not be projected to JSON Schema. */
export const NotProjectableSchemaMark = z
  .strictObject({ projectable: z.literal(false), reason: z.string() })
  .readonly();

/**
 * A projected JSON Schema or the explicit reason projection was unavailable.
 * The record arm preserves arbitrary JSON Schema annotation keys.
 */
const DirectorySchemaProjection = z.union([NotProjectableSchemaMark, JsonSchemaRecordSchema]);

/**
 * Serialisable projection of a subject declaration. Each unprojectable schema
 * on a request or volatile event carries a {@link NotProjectableSchemaMark}.
 */
export const SubjectDirectoryEntrySchema = z.discriminatedUnion('type', [
  z
    .object({
      ...subjectDirectoryEntryBase,
      type: z.literal('event'),
      /** JSON Schema of the event payload or its non-projectable mark. */
      schema: DirectorySchemaProjection,
      /** Whether entries are recorded; absent means volatile. */
      retention: z.enum(['recorded', 'volatile']).optional(),
      /** Version of the payload schema. */
      schemaVersion: z.string().min(1).optional(),
      /** Name of the strategy used for entries of older versions. */
      readOlder: z.enum(['as-recorded', 'upgrade']).optional(),
      /** Whether the payload is kept, or for how many milliseconds it is kept. */
      retainPayload: z
        .union([z.literal('keep'), z.object({ maxAgeMs: z.number().int().positive() }).strict()])
        .optional(),
    })
    .strict(),
  z
    .object({
      ...subjectDirectoryEntryBase,
      type: z.literal('request'),
      /** Independent JSON Schema projections or marks for the request and response. */
      schema: z.object({ request: DirectorySchemaProjection, response: DirectorySchemaProjection }).strict(),
    })
    .strict(),
]);
/** Serialisable projection of a subject declaration. */
export type SubjectDirectoryEntry = z.infer<typeof SubjectDirectoryEntrySchema>;

/** Request to list declared subjects. */
export const SubjectDirectoryListRequestSchema = z
  .object({
    /** Subject pattern in the bus subscription grammar; absent lists every subject. */
    pattern: SubjectPatternSchema.optional(),
  })
  .strict();
/** Request to list declared subjects. */
export type SubjectDirectoryListRequest = z.infer<typeof SubjectDirectoryListRequestSchema>;

/** Declared subjects. */
export const SubjectDirectoryListResponseSchema = z
  .object({
    /** The matching subject declarations. */
    subjects: z.array(SubjectDirectoryEntrySchema),
  })
  .strict();
/** Declared subjects. */
export type SubjectDirectoryListResponse = z.infer<typeof SubjectDirectoryListResponseSchema>;
