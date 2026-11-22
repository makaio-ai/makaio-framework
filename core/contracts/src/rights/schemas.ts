import { z } from 'zod';
import { ContributionNameSchema, ExtensionNameSchema } from '@makaio/core';
import { JsonSchemaRecordSchema, JsonValueSchema } from '../shared/json-value.js';

/**
 * Request to ask whether the caller holds one right in one context.
 *
 * The bus schema carries no call context: the core sets it from the caller.
 */
export const RightsResolveRequestSchema = z
  .object({
    /** The right that is asked about. */
    right: ContributionNameSchema,
    /** Context of the question; it follows the JSON schema of the right. */
    context: JsonValueSchema,
  })
  .strict();
/** Request to ask whether the caller holds one right in one context. */
export type RightsResolveRequest = z.infer<typeof RightsResolveRequestSchema>;

/**
 * Serialisable projection of a right declaration, without any function.
 *
 * Named gap: the list names neither the declaring extension nor the origin (code or data);
 * both fields are added with their first reader.
 */
export const RightDirectoryEntrySchema = z
  .object({
    /** Name of the right. */
    right: ContributionNameSchema,
    /** What the right allows, for people. */
    description: z.string(),
    /** JSON schema of the context of a question about this right. */
    context: JsonSchemaRecordSchema,
    /** Suggestion for which kinds of parties the right is meant; it grants nothing. */
    suggestedFor: z.array(ContributionNameSchema).optional(),
  })
  .strict();
/** Serialisable projection of a right declaration. */
export type RightDirectoryEntry = z.infer<typeof RightDirectoryEntrySchema>;

/** Request to list the declared rights. */
export const RightsListRequestSchema = z.object({}).strict();
/** Request to list the declared rights. */
export type RightsListRequest = z.infer<typeof RightsListRequestSchema>;

/** Declared rights. */
export const RightsListResponseSchema = z
  .object({
    /** The declared rights. */
    rights: z.array(RightDirectoryEntrySchema),
  })
  .strict();
/** Declared rights. */
export type RightsListResponse = z.infer<typeof RightsListResponseSchema>;

/**
 * Why the set of rights or answer sources changed: a right was declared, an answer source was registered,
 * or an answer source changed its content.
 */
export const RightsChangedReasonSchema = z.enum(['declared', 'source-registered', 'source-changed']);
/** Why the set of rights or answer sources changed. */
export type RightsChangedReason = z.infer<typeof RightsChangedReasonSchema>;

/**
 * Announcement that rights or their answer sources changed. The core is the only sender.
 */
export const RightsChangedSchema = z
  .object({
    /** The extension whose declaration changed. */
    owner: ExtensionNameSchema,
    /** Revision of the rights state after the change. */
    revision: z.number().int().min(0),
    /** Names or patterns of the rights concerned. */
    rights: z.array(z.string()),
    /** Why the rights changed. */
    reason: RightsChangedReasonSchema,
  })
  .strict();
/** Announcement that rights or their answer sources changed. */
export type RightsChanged = z.infer<typeof RightsChangedSchema>;
