import { z } from 'zod';
import { ContributionNameSchema, ExtensionNameSchema } from '@makaio/core';
import { JsonSchemaRecordSchema, JsonValueSchema } from '../shared/json-value.js';
import { SubjectPatternSchema } from '../journal/identifiers.js';

/** A contribution that could not be projected into a catalog entry. */
export const RuleCatalogFindingSchema = z
  .object({
    code: z.literal('catalog-contribution-failed'),
    extension: ExtensionNameSchema,
    kind: ContributionNameSchema,
    message: z.string(),
  })
  .strict();
/** @see {@link RuleCatalogFindingSchema} */
export type RuleCatalogFinding = z.infer<typeof RuleCatalogFindingSchema>;

/**
 * Request of `getTriggerCatalog`, at the bus `makaio:rules.triggers`.
 */
export const TriggerCatalogRequestSchema = z
  .object({
    /** Context forwarded to the schemas of contributed triggers. */
    catalogContext: JsonValueSchema.optional(),
  })
  .strict();
/** @see {@link TriggerCatalogRequestSchema} */
export type TriggerCatalogRequest = z.infer<typeof TriggerCatalogRequestSchema>;

/**
 * One entry of the trigger catalog.
 */
export const TriggerCatalogEntrySchema = z
  .object({
    /** Kind of trigger. */
    kind: ContributionNameSchema,
    /** Extension that contributes the trigger. */
    extension: ExtensionNameSchema,
    /** Human-readable description of the trigger. */
    description: z.string(),
    /** JSON schema of the trigger's parameters; `null` means the trigger takes none. */
    params: JsonSchemaRecordSchema.nullable(),
    /** JSON schema of the facts the trigger produces. */
    facts: JsonSchemaRecordSchema,
    /** Subjects the trigger fires from, for its default parameters. */
    subjects: z.array(SubjectPatternSchema),
  })
  .strict();
/** @see {@link TriggerCatalogEntrySchema} */
export type TriggerCatalogEntry = z.infer<typeof TriggerCatalogEntrySchema>;

/** Entry list of the trigger catalog. */
export const TriggerCatalogEntriesSchema = z.array(TriggerCatalogEntrySchema);
/** @see {@link TriggerCatalogEntriesSchema} */
export type TriggerCatalogEntries = z.infer<typeof TriggerCatalogEntriesSchema>;

/** Response of `getTriggerCatalog`. */
export const TriggerCatalogResponseSchema = z.object({
  entries: TriggerCatalogEntriesSchema,
  findings: z.array(RuleCatalogFindingSchema),
});
/** @see {@link TriggerCatalogResponseSchema} */
export type TriggerCatalogResponse = z.infer<typeof TriggerCatalogResponseSchema>;

/**
 * Request of `getReactionCatalog`, at the bus `makaio:rules.reactions`.
 */
export const ReactionCatalogRequestSchema = z.object({}).strict();
/** @see {@link ReactionCatalogRequestSchema} */
export type ReactionCatalogRequest = z.infer<typeof ReactionCatalogRequestSchema>;

/**
 * One entry of the reaction catalog.
 */
export const ReactionCatalogEntrySchema = z
  .object({
    /** Kind of reaction. */
    kind: ContributionNameSchema,
    /** Extension that contributes the reaction. */
    extension: ExtensionNameSchema,
    /** Human-readable description of the reaction. */
    description: z.string(),
    /** JSON schema of the reaction's parameters. */
    params: JsonSchemaRecordSchema,
    /** JSON schema of the reaction's result; `null` means it declares none. */
    result: JsonSchemaRecordSchema.nullable(),
    /** Whether the reaction acts at most once per key. */
    keyed: z.boolean(),
  })
  .strict();
/** @see {@link ReactionCatalogEntrySchema} */
export type ReactionCatalogEntry = z.infer<typeof ReactionCatalogEntrySchema>;

/** Entry list of the reaction catalog. */
export const ReactionCatalogEntriesSchema = z.array(ReactionCatalogEntrySchema);
/** @see {@link ReactionCatalogEntriesSchema} */
export type ReactionCatalogEntries = z.infer<typeof ReactionCatalogEntriesSchema>;

/** Response of `getReactionCatalog`. */
export const ReactionCatalogResponseSchema = z.object({
  entries: ReactionCatalogEntriesSchema,
  findings: z.array(RuleCatalogFindingSchema),
});
/** @see {@link ReactionCatalogResponseSchema} */
export type ReactionCatalogResponse = z.infer<typeof ReactionCatalogResponseSchema>;

/**
 * Request of `getLookupCatalog`, at the bus `makaio:rules.lookups`.
 */
export const LookupCatalogRequestSchema = TriggerCatalogRequestSchema;
/** @see {@link LookupCatalogRequestSchema} */
export type LookupCatalogRequest = z.infer<typeof LookupCatalogRequestSchema>;

/**
 * One entry of the lookup catalog.
 */
export const LookupCatalogEntrySchema = z
  .object({
    /** Kind of lookup. */
    kind: ContributionNameSchema,
    /** Extension that contributes the lookup. */
    extension: ExtensionNameSchema,
    /** Human-readable description of the lookup. */
    description: z.string(),
    /** JSON schema of the lookup's arguments. */
    args: JsonSchemaRecordSchema,
    /** JSON schema of the lookup's answer. */
    answer: JsonSchemaRecordSchema,
    /** Whether the lookup accepts `where`. */
    acceptsWhere: z.boolean(),
  })
  .strict();
/** @see {@link LookupCatalogEntrySchema} */
export type LookupCatalogEntry = z.infer<typeof LookupCatalogEntrySchema>;

/** Entry list of the lookup catalog. */
export const LookupCatalogEntriesSchema = z.array(LookupCatalogEntrySchema);
/** @see {@link LookupCatalogEntriesSchema} */
export type LookupCatalogEntries = z.infer<typeof LookupCatalogEntriesSchema>;

/** Response of `getLookupCatalog`. */
export const LookupCatalogResponseSchema = z.object({
  entries: LookupCatalogEntriesSchema,
  findings: z.array(RuleCatalogFindingSchema),
});
/** @see {@link LookupCatalogResponseSchema} */
export type LookupCatalogResponse = z.infer<typeof LookupCatalogResponseSchema>;
