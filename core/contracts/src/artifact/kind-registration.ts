import { z } from 'zod';
import { JsonObjectContractSchema } from '../shared/json-value.js';
import { validateKindDataPaths } from './kind-paths.js';

/** Positive schema generation; Zod 4 int() enforces safe integers. Revision identifiers remain strings. */
export const ArtifactSchemaVersionSchema = z.number().int().positive();
/** Shared semantic categories, independent of concrete artifact kinds. */
export const ArtifactCategorySchema = z.enum(['knowledge', 'commitment', 'interaction', 'record']);
/** Named object properties relative to data. Array indices and wildcards are not supported. */
export const ArtifactDataPathSchema = z.string().regex(/^[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*)*$/);

/** A named, lossless selection of original fields from an artifact payload. */
export const ArtifactKindViewSchema = z.strictObject({
  /** Data-relative object-property paths included in this view. */
  fields: z.array(ArtifactDataPathSchema).min(1),
});

/** Name reserved for the generic complete-payload view. */
const RESERVED_ARTIFACT_KIND_VIEW_NAMES = new Set(['full']);

/** Category states usable in declarative uniqueness conditions, not a transition engine. */
export const ARTIFACT_CATEGORY_LIFECYCLE_STATES = {
  knowledge: ['valid', 'retired'],
  commitment: ['proposed', 'decided', 'fulfilled', 'revoked'],
  interaction: ['open', 'resolved', 'closed-without-resolution'],
  record: [],
} as const;

/** Shared lifecycle names accepted by declaration conditions. */
export const ArtifactLifecycleStateSchema = z.enum([
  ...ARTIFACT_CATEGORY_LIFECYCLE_STATES.knowledge,
  ...ARTIFACT_CATEGORY_LIFECYCLE_STATES.commitment,
  ...ARTIFACT_CATEGORY_LIFECYCLE_STATES.interaction,
]);

/** Additional relation requirement; undeclared relation types remain permitted. */
export const ArtifactRelationRequirementSchema = z
  .strictObject({
    relationType: z.string().trim().min(1),
    targetKinds: z.array(z.string().trim().min(1)).min(1).optional(),
    minItems: z.number().int().nonnegative(),
    maxItems: z.number().int().nonnegative().optional(),
  })
  .refine((value) => value.maxItems === undefined || value.maxItems >= value.minItems, {
    path: ['maxItems'],
    message: 'maxItems must be at least minItems',
  });

/** One contribution to an explicit uniqueness key. Relation targets exclude revision pins. */
export const ArtifactUniquenessSelectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('data'), path: ArtifactDataPathSchema }),
  z.strictObject({ kind: z.literal('relation-target'), relationType: z.string().trim().min(1) }),
]);

/** A complete uniqueness key with optional category-compatible lifecycle conditions. */
export const ArtifactUniquenessRuleSchema = z.strictObject({
  by: z.array(ArtifactUniquenessSelectorSchema).min(1),
  lifecycleStates: z.array(ArtifactLifecycleStateSchema).min(1).optional(),
});

/** Minimum number of direct revision evidence entries. */
export const ArtifactEvidenceRequirementsSchema = z.strictObject({
  minItems: z.number().int().nonnegative(),
});

/** Dialects supported by the artifact write validators; omission retains draft-7 semantics. */
const ArtifactDataSchemaDialectSchema = z
  .enum(['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2020-12/schema'])
  .optional();

/** Serializable kind contract. Concrete runtime enforcement belongs to the artifact service. */
export const ArtifactKindRegistrationSchema = z
  .strictObject({
    kind: z.string().trim().min(1),
    description: z.string().trim().min(1),
    schemaVersion: ArtifactSchemaVersionSchema,
    category: ArtifactCategorySchema,
    dataSchema: JsonObjectContractSchema,
    titlePath: ArtifactDataPathSchema,
    relations: z.array(ArtifactRelationRequirementSchema).optional(),
    uniqueness: z.array(ArtifactUniquenessRuleSchema).optional(),
    evidenceRequirements: ArtifactEvidenceRequirementsSchema.optional(),
    indexedFields: z.array(ArtifactDataPathSchema).optional(),
    searchableFields: z.array(ArtifactDataPathSchema).optional(),
    views: z.record(z.string().trim().min(1), ArtifactKindViewSchema).optional(),
  })
  .superRefine((value, ctx) => {
    if (!ArtifactDataSchemaDialectSchema.safeParse(value.dataSchema.$schema).success) {
      ctx.addIssue({
        code: 'custom',
        path: ['dataSchema', '$schema'],
        message:
          'Unsupported data schema dialect: omit $schema for draft-7 or declare the supported draft-7 or 2020-12 URI',
      });
    }
    const allowed: readonly string[] = ARTIFACT_CATEGORY_LIFECYCLE_STATES[value.category];
    value.uniqueness?.forEach((rule, index) => {
      if (rule.lifecycleStates?.some((state) => !allowed.includes(state))) {
        ctx.addIssue({
          code: 'custom',
          path: ['uniqueness', index, 'lifecycleStates'],
          message: `Lifecycle conditions are incompatible with category ${value.category}`,
        });
      }
    });
    Object.keys(value.views ?? {}).forEach((name) => {
      if (RESERVED_ARTIFACT_KIND_VIEW_NAMES.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['views', name],
          message: `Artifact kind view ${name} is reserved for the generic complete-payload view`,
        });
      }
    });
    validateKindDataPaths(value, ctx);
  });

/** Semantic category of an artifact kind. */
export type ArtifactCategory = z.infer<typeof ArtifactCategorySchema>;
/** Shared lifecycle name for declaration conditions. */
export type ArtifactLifecycleState = z.infer<typeof ArtifactLifecycleStateSchema>;
/** Additional relation cardinality declaration. */
export type ArtifactRelationRequirement = z.infer<typeof ArtifactRelationRequirementSchema>;
/** Explicit uniqueness declaration. */
export type ArtifactUniquenessRule = z.infer<typeof ArtifactUniquenessRuleSchema>;
/** Direct evidence cardinality declaration. */
export type ArtifactEvidenceRequirements = z.infer<typeof ArtifactEvidenceRequirementsSchema>;
/** Named lossless field selection declared by an artifact kind. */
export type ArtifactKindView = z.infer<typeof ArtifactKindViewSchema>;
/** Serializable artifact kind definition. */
export type ArtifactKindRegistration = z.infer<typeof ArtifactKindRegistrationSchema>;
