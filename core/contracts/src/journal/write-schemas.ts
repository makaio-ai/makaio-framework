import { z } from 'zod';
import { CallContextRecordSchema, ContributionNameSchema } from '@makaio/core';
import { JsonValueSchema } from '../shared/json-value.js';
import { ExternalObjectRefSchema } from './external-object-ref.js';
import { IntentIdSchema, WriteKeySchema, WriteRecordIdSchema } from './write-identifiers.js';

/** Page size used when a paged write request omits `limit`. */
export const WRITE_PAGE_DEFAULT_LIMIT = 50;

/** Largest page size a paged write request may ask for. */
export const WRITE_PAGE_MAX_LIMIT = 500;

/**
 * Page size of a paged write request.
 *
 * Not defaulted here: an absent `limit` means {@link WRITE_PAGE_DEFAULT_LIMIT}.
 * A value above {@link WRITE_PAGE_MAX_LIMIT} is a schema error, never silently capped.
 */
export const WritePageLimitSchema = z.number().int().min(1).max(WRITE_PAGE_MAX_LIMIT);

/** Description of an object a write is to create. */
export const CreateTargetSchema = z
  .object({
    /** Site inside the external system in which the object is created. */
    site: z.string().min(1),
    /** Type of the object to create. */
    objectType: z.string().min(1),
    /** Parent the new object is created below. */
    parent: ExternalObjectRefSchema.optional(),
  })
  .strict();
/** Description of an object a write is to create. */
export type CreateTarget = z.infer<typeof CreateTargetSchema>;

/** Target of a write: an object to create or an existing object to update. */
export const WriteTargetSchema = z.union([
  z
    .object({
      /** The object to create. */
      create: CreateTargetSchema,
    })
    .strict(),
  z
    .object({
      /** The existing object to update. */
      existing: ExternalObjectRefSchema,
    })
    .strict(),
]);
/** Target of a write: an object to create or an existing object to update. */
export type WriteTarget = z.infer<typeof WriteTargetSchema>;

/** Request to write one object into an external system. */
export const WriteRequestSchema = z
  .object({
    /** Key of the write, formed by the caller; the key space is `(writer, key)`. */
    key: WriteKeySchema,
    /** Writer that performs the write. */
    writer: ContributionNameSchema,
    /** Object to create or update. */
    target: WriteTargetSchema,
    /** Content to write; validated against the content schema of the writer. */
    content: JsonValueSchema,
    /** Checksum of the content, used to detect an unchanged write. */
    checksum: z.string().optional(),
    /** Order of the write; a write with a lower order than the applied one is outdated. */
    order: z.number().optional(),
    /** Credential the writer needs. */
    credential: z
      .object({
        /** Purpose the credential is requested for. */
        purpose: z.string(),
        /** Target the credential is requested for; interpreted by the credential provider. */
        target: JsonValueSchema.optional(),
      })
      .strict(),
    /** Write participant that takes part in the state transitions of this write. */
    participant: z
      .object({
        /** Name of the write participant. */
        name: ContributionNameSchema,
        /** Data handed to the participant with every transition. */
        data: JsonValueSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
/** Request to write one object into an external system. */
export type WriteRequest = z.infer<typeof WriteRequestSchema>;

/** State of a write record. */
export const WriteStateSchema = z.enum(['intended', 'written', 'not-written', 'unresolved', 'released', 'resolved']);
/** State of a write record. */
export type WriteState = z.infer<typeof WriteStateSchema>;

/** Read view of one write record. */
export const WriteRecordViewSchema = z
  .object({
    /** Identifier of the write record. */
    writeRecordId: WriteRecordIdSchema,
    /** Key of the write. */
    key: WriteKeySchema,
    /** Writer that performs the write. */
    writer: ContributionNameSchema,
    /** Current state of the write. */
    state: WriteStateSchema,
    /** The written object; null while no object is known. */
    object: ExternalObjectRefSchema.nullable(),
    /** Parent of the written object; null when there is none or none is known. */
    parent: ExternalObjectRefSchema.nullable(),
    /** Identifier of the write intent; null when none exists. */
    intentId: IntentIdSchema.nullable(),
    /** Checksum of the applied content; null when none was given. */
    checksum: z.string().nullable(),
    /** Order of the applied write; null when none was applied. */
    appliedOrder: z.number().nullable(),
    /** Time since which the write is intended; null when it is not intended. */
    intendedSince: z.string().nullable(),
    /** Call context under which the write was recorded. */
    ctx: CallContextRecordSchema,
  })
  .strict();
/** Read view of one write record. */
export type WriteRecordView = z.infer<typeof WriteRecordViewSchema>;

/** Request to read write records, either by write key or by external object. */
export const JournalWritesRequestSchema = z.union([
  z
    .object({
      /** Reads the writes of one `(writer, key)`. */
      byKey: z
        .object({
          /** Writer of the writes. */
          writer: ContributionNameSchema,
          /** Key of the writes. */
          key: WriteKeySchema,
        })
        .strict(),
      /** Page size; absent means the default limit. */
      limit: WritePageLimitSchema.optional(),
      /** Opaque continuation token of a previous page. */
      cursor: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      /** Reads the writes that produced or touched this object. */
      byObject: ExternalObjectRefSchema,
      /** Page size; absent means the default limit. */
      limit: WritePageLimitSchema.optional(),
      /** Opaque continuation token of a previous page. */
      cursor: z.string().min(1).optional(),
    })
    .strict(),
]);
/** Request to read write records, either by write key or by external object. */
export type JournalWritesRequest = z.infer<typeof JournalWritesRequestSchema>;

/**
 * One page of write records.
 *
 * The order is fixed: by creation time, then `writeRecordId`, ascending.
 */
export const JournalWritesPageSchema = z
  .object({
    /** Write records of the page, in the fixed order. */
    writes: z.array(WriteRecordViewSchema),
    /** Opaque token for the next page; absent on the last page. */
    nextCursor: z.string().min(1).optional(),
  })
  .strict();
/** One page of write records. */
export type JournalWritesPage = z.infer<typeof JournalWritesPageSchema>;

/** Request to resolve an unresolved write manually. */
export const JournalResolveWriteRequestSchema = z
  .object({
    /** The unresolved write record. */
    writeRecordId: WriteRecordIdSchema,
    /** Decision: the object exists, or it was not written. */
    resolution: z.union([
      z
        .object({
          /** The object was written and is this one. */
          found: ExternalObjectRefSchema,
        })
        .strict(),
      z
        .object({
          /** The object was not written. */
          notWritten: z.literal(true),
        })
        .strict(),
    ]),
  })
  .strict();
/** Request to resolve an unresolved write manually. */
export type JournalResolveWriteRequest = z.infer<typeof JournalResolveWriteRequestSchema>;

/** Response to a manual resolution of a write. */
export const JournalResolveWriteResponseSchema = z.discriminatedUnion('success', [
  z
    .object({
      /** The resolution was applied. */
      success: z.literal(true),
      /** The write record after the resolution. */
      record: WriteRecordViewSchema,
    })
    .strict(),
  z
    .object({
      /** The resolution was not applied. */
      success: z.literal(false),
      /** Why it was not applied. */
      code: z.enum(['not-found', 'not-unresolved', 'participant-unavailable']),
    })
    .strict(),
]);
/** Response to a manual resolution of a write. */
export type JournalResolveWriteResponse = z.infer<typeof JournalResolveWriteResponseSchema>;
