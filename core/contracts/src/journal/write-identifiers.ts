import { z } from 'zod';
import type { ContributionName } from '@makaio/core';

/**
 * Name of a writer: a contribution that creates or updates objects in one
 * external system. Owned by the contributing extension like every
 * contribution name.
 */
export type WriterName = ContributionName;

/**
 * Schema of a write key. A write key is formed by the caller; the key space
 * is `(writer, key)`, so the same key of two writers names two different
 * writes.
 */
export const WriteKeySchema = z.string().min(1);

/**
 * Key of one write, formed by the caller. The key space is `(writer, key)`.
 */
export type WriteKey = z.infer<typeof WriteKeySchema>;

/**
 * Schema of the identifier of a write intent. Kept as wide as the recorded
 * field; it names the intent a participant step belongs to.
 */
export const IntentIdSchema = z.string();

/** Identifier of one write intent. */
export type IntentId = z.infer<typeof IntentIdSchema>;

/** Schema of the identifier of a write record. */
export const WriteRecordIdSchema = z.string().min(1);

/** Identifier of one write record. */
export type WriteRecordId = z.infer<typeof WriteRecordIdSchema>;
