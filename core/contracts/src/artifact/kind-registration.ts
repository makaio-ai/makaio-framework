import { z } from 'zod';
import { JsonObjectContractSchema } from '../shared/json-value.js';
import { isArtifactDataPathDeclared, validateKindDataPaths } from './kind-paths.js';
import { validateSchemaDialect } from './kind-schema-dialect.js';
import { mayArtifactDataCarryProperty } from './kind-reserved-fields.js';
import { ARTIFACT_SLUG_FIELD } from './slug.js';
import { validateArtifactPartAreas } from './artifact-parts.js';

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

/** Applies the requirement only when the artifact data holds `equals` at `path`. */
export const ArtifactRelationRequirementConditionSchema = z.strictObject({
  /** Data-relative object-property path to the field the condition reads. */
  path: ArtifactDataPathSchema,
  /** Scalar value the field must hold, compared by exact equality. */
  equals: z.union([z.string(), z.number(), z.boolean()]),
});

/**
 * Additional relation requirement; undeclared relation types remain permitted.
 * Without `when` the requirement always applies. With `when` it applies only when
 * the value at `when.path` equals `when.equals`; it is skipped when that value is
 * missing, non-scalar, or not equal.
 */
export const ArtifactRelationRequirementSchema = z
  .strictObject({
    relationType: z.string().trim().min(1),
    targetKinds: z.array(z.string().trim().min(1)).min(1).optional(),
    minItems: z.number().int().nonnegative(),
    maxItems: z.number().int().nonnegative().optional(),
    when: ArtifactRelationRequirementConditionSchema.optional(),
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

/** One data area whose array elements are stably addressable parts of the artifact. */
export const ArtifactPartAreaSchema = z.strictObject({
  /** Data-relative object-property path to the array that holds the parts. */
  path: ArtifactDataPathSchema,
  /** Element-relative object-property path to a part's stable local identifier. */
  idPath: ArtifactDataPathSchema,
});

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
    /** Declared areas whose elements are addressable through a local ref; local identifiers are unique across all declared areas of one revision. */
    addressableParts: z.array(ArtifactPartAreaSchema).min(1).optional(),
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
    value.relations?.forEach((requirement, index) => {
      if (requirement.when && !isArtifactDataPathDeclared(value.dataSchema, requirement.when.path)) {
        ctx.addIssue({
          code: 'custom',
          path: ['relations', index, 'when', 'path'],
          message: `Data path ${requirement.when.path} must select a declared field`,
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
    if (mayArtifactDataCarryProperty(value.dataSchema, ARTIFACT_SLUG_FIELD)) {
      ctx.addIssue({
        code: 'custom',
        path: ['dataSchema', 'properties', ARTIFACT_SLUG_FIELD],
        message: `Data field ${ARTIFACT_SLUG_FIELD} is reserved: the artifact envelope owns the slug`,
      });
    }
    validateSchemaDialect(value.dataSchema, ctx);
    validateKindDataPaths(value, ctx);
    validateArtifactPartAreas(value, ctx);
  });

/** Semantic category of an artifact kind. */
export type ArtifactCategory = z.infer<typeof ArtifactCategorySchema>;
/** Shared lifecycle name for declaration conditions. */
export type ArtifactLifecycleState = z.infer<typeof ArtifactLifecycleStateSchema>;
/** Additional relation cardinality declaration. */
export type ArtifactRelationRequirement = z.infer<typeof ArtifactRelationRequirementSchema>;
/** Data condition under which a relation requirement applies. */
export type ArtifactRelationRequirementCondition = z.infer<typeof ArtifactRelationRequirementConditionSchema>;
/** Explicit uniqueness declaration. */
export type ArtifactUniquenessRule = z.infer<typeof ArtifactUniquenessRuleSchema>;
/** Direct evidence cardinality declaration. */
export type ArtifactEvidenceRequirements = z.infer<typeof ArtifactEvidenceRequirementsSchema>;
/** Named lossless field selection declared by an artifact kind. */
export type ArtifactKindView = z.infer<typeof ArtifactKindViewSchema>;
/** One declared data area whose array elements are stably addressable parts. */
export type ArtifactPartArea = z.infer<typeof ArtifactPartAreaSchema>;
/** Serializable artifact kind definition. */
export type ArtifactKindRegistration = z.infer<typeof ArtifactKindRegistrationSchema>;
