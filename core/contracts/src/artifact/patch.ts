import { z } from 'zod';

import { JsonValueSchema, rejectingLossyJsonValues } from '../shared/json-value.js';
import { ArtifactRefSchema } from './artifact-reference.js';
import { ArtifactStatusPathSchema } from './schemas.js';

/**
 * Update operators this contract declares.
 *
 * The set is a deliberately narrow subset of Mongo update semantics. It is
 * closed: an operator outside this list is rejected by the request schema
 * rather than ignored, so a caller never believes an unsupported instruction
 * was carried out.
 */
export const ARTIFACT_PATCH_OPERATORS = ['$set', '$unset', '$push', '$pull'] as const;

/** One declared update operator. */
export type ArtifactPatchOperator = (typeof ARTIFACT_PATCH_OPERATORS)[number];

/** Name of an array filter placeholder, as declared and as referenced. */
const PATCH_PLACEHOLDER_NAME = '[A-Za-z_$][A-Za-z0-9_$]*';
/** Object property name usable as a patch path segment. */
const PATCH_PROPERTY_SEGMENT = '[A-Za-z_$][A-Za-z0-9_$-]*';
/** Canonical non-negative array position; leading zeros are not a position. */
const PATCH_INDEX_SEGMENT = '(?:0|[1-9][0-9]*)';
/** Array filter placeholder, spelled as in Mongo. */
const PATCH_FILTER_SEGMENT = `\\$\\[${PATCH_PLACEHOLDER_NAME}\\]`;
/** Any segment after the first; the first segment addresses a property of `data`. */
const PATCH_SEGMENT = `(?:${PATCH_FILTER_SEGMENT}|${PATCH_INDEX_SEGMENT}|${PATCH_PROPERTY_SEGMENT})`;

/** Matches a complete patch path. */
const ARTIFACT_PATCH_PATH_PATTERN = new RegExp(`^${PATCH_PROPERTY_SEGMENT}(?:\\.${PATCH_SEGMENT})*$`);
/** Matches one array filter key: the bound placeholder name, optionally followed by a property path. */
const ARTIFACT_PATCH_FILTER_KEY_PATTERN = new RegExp(`^${PATCH_PLACEHOLDER_NAME}(?:\\.${PATCH_PROPERTY_SEGMENT})*$`);
/** Matches exactly one array position segment. */
const ARTIFACT_PATCH_INDEX_PATTERN = new RegExp(`^${PATCH_INDEX_SEGMENT}$`);
/** Matches exactly one array filter segment, capturing the placeholder it references. */
const ARTIFACT_PATCH_FILTER_PATTERN = new RegExp(`^\\$\\[(${PATCH_PLACEHOLDER_NAME})\\]$`);

/**
 * A dot-separated location inside artifact `data`.
 *
 * The first segment is always an object property of `data`. Later segments are
 * an object property, a canonical array position (`tasks.3.title`), or an array
 * filter placeholder (`tasks.$[entry].title`) bound by `arrayFilters`. Filter
 * addressing is what keeps a write independent of the list order a caller read
 * earlier, so a concurrent insertion does not silently move the target.
 */
export const ArtifactPatchPathSchema = z
  .string()
  .regex(
    ARTIFACT_PATCH_PATH_PATTERN,
    'Expected a data-relative path of object properties, array positions, or $[filter] placeholders',
  );

/** What one segment of a patch path addresses. */
export type ArtifactPatchSegment =
  | { readonly kind: 'property'; readonly name: string }
  | { readonly kind: 'index'; readonly index: number }
  | { readonly kind: 'filter'; readonly placeholder: string };

/**
 * Classify one segment of a patch path.
 *
 * The grammar lives here alongside the pattern that admits it, so a caller
 * walking a path can never disagree with the schema that accepted it.
 * @param segment - One segment of a path already accepted by {@link ArtifactPatchPathSchema}.
 * @returns What the segment addresses.
 */
export function artifactPatchSegment(segment: string): ArtifactPatchSegment {
  const filter = ARTIFACT_PATCH_FILTER_PATTERN.exec(segment);
  if (filter?.[1] !== undefined) return { kind: 'filter', placeholder: filter[1] };
  if (ARTIFACT_PATCH_INDEX_PATTERN.test(segment)) return { kind: 'index', index: Number(segment) };
  return { kind: 'property', name: segment };
}

/**
 * Split a patch path into its classified segments.
 * @param path - Path already accepted by {@link ArtifactPatchPathSchema}.
 * @returns One classified segment per path element, in order.
 */
export function artifactPatchSegments(path: string): ArtifactPatchSegment[] {
  return path.split('.').map(artifactPatchSegment);
}

/**
 * List the array filter placeholders a patch path refers to.
 * @param path - Path already accepted by {@link ArtifactPatchPathSchema}.
 * @returns Placeholder names in order of appearance, with duplicates retained.
 */
export function artifactPatchPathFilterNames(path: string): string[] {
  return artifactPatchSegments(path).flatMap((segment) => (segment.kind === 'filter' ? [segment.placeholder] : []));
}

/**
 * One `arrayFilters` entry, restricted to equality on the matched element.
 *
 * Every key starts with the placeholder name this entry binds. The bare name
 * compares the whole element; `name.field.path` compares one property of it.
 * Comparison operators are outside the declared subset.
 */
export const ArtifactPatchArrayFilterSchema = rejectingLossyJsonValues(
  z.record(
    z.string().regex(ARTIFACT_PATCH_FILTER_KEY_PATTERN, 'Expected a filter key of the form name or name.field.path'),
    JsonValueSchema,
  ),
  {
    prototypeKey: 'an array filter cannot compare a __proto__ key, which JSON transport drops',
    nonPlainObject: 'an array filter must be a plain object of comparison keys',
    symbolKey: 'an array filter cannot carry symbol-keyed comparisons',
    nonEnumerableKey: 'an array filter cannot carry non-enumerable comparison keys',
    extraArrayKey: 'an array filter must be a plain object, not an array',
  },
);

/**
 * Read the placeholder name an array filter binds.
 * @param filter - One array filter entry.
 * @returns The single bound placeholder name, or undefined when the entry binds none or several.
 */
export function artifactPatchFilterName(filter: Record<string, unknown>): string | undefined {
  const names = new Set(Object.keys(filter).map((key) => key.split('.')[0]));
  if (names.size !== 1) return undefined;
  const [name] = names;
  return name !== undefined && name.length > 0 ? name : undefined;
}

/**
 * Guard one operator's instruction map against silently rewritten keys.
 *
 * Zod rebuilds a record from its own enumerable string keys, which drops an own
 * `__proto__`. For a patch that would mean an instruction disappearing between
 * the caller and the engine while the remaining instructions still applied — a
 * partial write reported as a complete one. Rejecting the request instead keeps
 * the all-or-nothing promise intact.
 * @param operator - Operator whose instruction map is being guarded.
 * @param values - Schema for the operator's operands.
 * @typeParam TValues - Operand schema being guarded.
 * @returns The instruction map schema, preceded by the raw-input rejection.
 */
function instructionMap<TValues extends z.ZodType>(
  operator: ArtifactPatchOperator,
  values: TValues,
): z.ZodType<Record<string, z.output<TValues>>, Record<string, z.input<TValues>>> {
  return rejectingLossyJsonValues(z.record(ArtifactPatchPathSchema, values), {
    prototypeKey: `${operator} cannot address __proto__, which JSON transport drops`,
    nonPlainObject: `${operator} must be a plain object of path instructions`,
    symbolKey: `${operator} cannot carry symbol-keyed instructions`,
    nonEnumerableKey: `${operator} cannot carry non-enumerable instructions`,
    extraArrayKey: `${operator} must be a plain object, not an array`,
  }) as z.ZodType<Record<string, z.output<TValues>>, Record<string, z.input<TValues>>>;
}

/** `$unset` carries no value; `true` states the intent explicitly on the wire. */
const ArtifactPatchUnsetMarkerSchema = z.literal(true);

const ArtifactPatchOperationsSchema = z.strictObject({
  /** Replace or introduce the value at each declared path. */
  $set: instructionMap('$set', JsonValueSchema).optional(),
  /** Remove each addressed object property. Array elements are removed with `$pull`. */
  $unset: instructionMap('$unset', ArtifactPatchUnsetMarkerSchema).optional(),
  /** Append one element to each addressed collection. `$each` is outside the subset. */
  $push: instructionMap('$push', JsonValueSchema).optional(),
  /** Remove the matching elements from each addressed collection. */
  $pull: instructionMap('$pull', JsonValueSchema).optional(),
  /** Bindings for the `$[name]` placeholders used by the paths above. */
  arrayFilters: z.array(ArtifactPatchArrayFilterSchema).optional(),
});

/** One instruction of a patch document: an operator, where it applies, and its operand. */
export interface ArtifactPatchInstruction {
  /** Operator to apply. */
  readonly operator: ArtifactPatchOperator;
  /** Path the operator applies to. */
  readonly path: string;
  /** Value or condition the caller wrote for this path. */
  readonly value: unknown;
}

/**
 * List every instruction of a patch document in application order.
 *
 * Operators run in the order {@link ARTIFACT_PATCH_OPERATORS} declares and,
 * within one operator, in the order the caller wrote its paths, so the same
 * document always produces the same result.
 *
 * The parameter is spelled structurally rather than as the document type,
 * because the document's own schema calls this while refining itself.
 * @param patch - Structurally valid patch operations.
 * @returns Operator, path and operand for each declared instruction.
 */
export function artifactPatchInstructions(
  patch: Readonly<Partial<Record<ArtifactPatchOperator, Readonly<Record<string, unknown>>>>>,
): ArtifactPatchInstruction[] {
  return ARTIFACT_PATCH_OPERATORS.flatMap((operator) =>
    Object.entries(patch[operator] ?? {}).map(([path, value]) => ({ operator, path, value })),
  );
}

/**
 * Reject a patch whose placeholders and filters do not correspond exactly.
 * @param patch - Structurally valid patch operations.
 * @param ctx - Zod refinement context receiving actionable issues.
 */
function validateArtifactPatchBindings(
  patch: z.infer<typeof ArtifactPatchOperationsSchema>,
  ctx: z.RefinementCtx,
): void {
  const instructions = artifactPatchInstructions(patch);
  if (instructions.length === 0) {
    ctx.addIssue({ code: 'custom', message: `Declare at least one of ${ARTIFACT_PATCH_OPERATORS.join(', ')}` });
    return;
  }
  const bound = new Map<string, number>();
  (patch.arrayFilters ?? []).forEach((filter, index) => {
    const name = artifactPatchFilterName(filter);
    if (name === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['arrayFilters', index],
        message: 'An array filter must bind exactly one placeholder name across all of its keys',
      });
      return;
    }
    if (bound.has(name)) {
      ctx.addIssue({
        code: 'custom',
        path: ['arrayFilters', index],
        message: `Array filter placeholder ${name} is already bound by another filter`,
      });
      return;
    }
    bound.set(name, index);
  });
  const referenced = new Set<string>();
  for (const { operator, path } of instructions) {
    for (const name of artifactPatchPathFilterNames(path)) {
      referenced.add(name);
      if (!bound.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path: [operator, path],
          message: `Path uses placeholder $[${name}] without a matching entry in arrayFilters`,
        });
      }
    }
  }
  for (const [name, index] of bound) {
    if (!referenced.has(name)) {
      ctx.addIssue({
        code: 'custom',
        path: ['arrayFilters', index],
        message: `Array filter binds placeholder ${name}, which no path uses`,
      });
    }
  }
}

/**
 * A complete patch document.
 *
 * Cross-field rules — at least one instruction, and placeholders matching their
 * filters exactly — are refinements. A JSON Schema rendering of this subject
 * therefore describes the operator set and the path grammar but not those
 * rules, exactly as for the other refined artifact contracts; the server
 * rejects a document that only the refinements catch.
 */
export const ArtifactPatchDocumentSchema = ArtifactPatchOperationsSchema.superRefine(validateArtifactPatchBindings);

/** Identity of the artifact being revised; the revision travels as `baseRevision`. */
export const ArtifactPatchTargetSchema = z.strictObject({
  kind: ArtifactRefSchema.shape.kind,
  id: ArtifactRefSchema.shape.id,
});

/**
 * Request one patch-based artifact revision.
 *
 * `baseRevision` is mandatory: the write applies to that exact revision or is
 * rejected, so a caller never overwrites a concurrent revision it never saw.
 * `statusPath` is the same caller-owned observation metadata a full `revise`
 * carries, so patching an artifact does not silently lose the status change a
 * host would otherwise emit.
 */
export const ArtifactPatchRequestSchema = z.strictObject({
  /** Artifact identity to revise. */
  ref: ArtifactPatchTargetSchema,
  /** Revision the patch was written against. */
  baseRevision: ArtifactRefSchema.shape.revision,
  /** Instructions to apply to that revision's `data`. */
  patch: ArtifactPatchDocumentSchema,
  /** Apply and validate without persisting, returning the same diagnostics. */
  dryRun: z.boolean().optional(),
  /**
   * Explicit caller-owned status observation for this write only, as a
   * `data`-relative JSON Pointer. The host derives the change from the
   * revisions around the write; this metadata is never stored.
   */
  statusPath: ArtifactStatusPathSchema.optional(),
});

/** Stable failure classifications for a patch request. */
export const ARTIFACT_PATCH_ERROR_CODES = [
  /** No artifact exists for the requested kind and identity. */
  'ARTIFACT_NOT_FOUND',
  /**
   * The artifact advanced past `baseRevision`; the current revision is reported.
   * Nothing was persisted: the write was either rejected before it ran or
   * refused by the store.
   */
  'BASE_REVISION_CONFLICT',
  /** The artifact kind has no effective registration. */
  'KIND_NOT_REGISTERED',
  /** No registration matches the stored revision's schema version. */
  'SCHEMA_VERSION_MISMATCH',
  /** The kind schema does not declare the addressed path. */
  'PATH_NOT_DECLARED',
  /** The path is declared but the stored revision has no value along it. */
  'PATH_NOT_RESOLVABLE',
  /** The operator addressed a collection that the value at the path is not. */
  'TARGET_NOT_A_COLLECTION',
  /** The operator cannot address this kind of target. */
  'UNSUPPORTED_TARGET',
  /** The addressing selected no entry, which is a failure rather than a no-op. */
  'NO_MATCH',
  /** The patched result does not satisfy the kind schema. */
  'SCHEMA_VALIDATION_FAILED',
  /**
   * The host could not resolve or persist the artifact. When it failed while
   * persisting, the outcome is unknown rather than known to be absent: the
   * caller must re-read before retrying.
   */
  'HOST_FAILED',
] as const;

/** One reason the patched result was rejected, addressed within `data`. */
export const ArtifactPatchIssueSchema = z.strictObject({
  /** Dot-separated `data` path of the rejected value; empty for the payload root. */
  path: z.string(),
  /** What the schema expected at that path. */
  reason: z.string().min(1),
  /** Declared type at that path, when the rejection names one. */
  expectedType: z.string().min(1).optional(),
  /** Declared value set at that path, when the rejection names one. */
  allowedValues: z.array(JsonValueSchema).optional(),
});

/**
 * A rejected patch request.
 *
 * Every rejection names the failing location and carries a repair hint, so a
 * caller learns the next step from the rejection itself. The hint is what
 * distinguishes a correctable request from an outcome that is unknown, so it is
 * required rather than optional.
 *
 * A `BASE_REVISION_CONFLICT` additionally names the revision the artifact
 * carries: recovery from a conflict is rebasing onto that revision, so a
 * conflict without it would be unactionable. The schema enforces the pairing
 * rather than trusting each producer to remember it.
 */
export const ArtifactPatchErrorSchema = z
  .strictObject({
    /** Stable failure classification. */
    code: z.enum(ARTIFACT_PATCH_ERROR_CODES),
    /** Human-readable explanation. */
    message: z.string().min(1),
    /** Operator whose instruction failed, when one instruction is responsible. */
    operator: z.enum(ARTIFACT_PATCH_OPERATORS).optional(),
    /** Patch path that failed, when one path is responsible. */
    path: ArtifactPatchPathSchema.optional(),
    /** Revision the artifact actually carries; required on a base revision conflict. */
    currentRevision: ArtifactRefSchema.shape.revision.optional(),
    /** Per-path schema rejections of the patched result. */
    issues: z.array(ArtifactPatchIssueSchema).optional(),
    /** Concrete next step for the caller; every rejection names one. */
    repair: z.string().min(1),
  })
  .superRefine((error, ctx) => {
    if (error.code === 'BASE_REVISION_CONFLICT' && error.currentRevision === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A BASE_REVISION_CONFLICT must name the revision the artifact carries.',
        path: ['currentRevision'],
      });
    }
  });

/** What one applied instruction did. */
export const ArtifactPatchOperationResultSchema = z.strictObject({
  /** Operator that was applied. */
  operator: z.enum(ARTIFACT_PATCH_OPERATORS),
  /** Path the operator was applied to. */
  path: ArtifactPatchPathSchema,
  /** Number of locations the instruction changed; never zero. */
  matched: z.number().int().positive(),
});

const ArtifactPatchAppliedSchema = z.strictObject({
  ok: z.literal(true),
  /** Revision the patch was applied to. */
  base: ArtifactRefSchema,
  /** One entry per applied instruction, in application order. */
  operations: z.array(ArtifactPatchOperationResultSchema).min(1),
});

/** A patch that was applied, validated and discarded without producing history. */
export const ArtifactPatchDryRunSchema = ArtifactPatchAppliedSchema.extend({
  dryRun: z.literal(true),
});

/** A patch that was applied, validated and persisted as a new revision. */
export const ArtifactPatchPersistedSchema = ArtifactPatchAppliedSchema.extend({
  dryRun: z.literal(false),
  /** Reference to the new revision. */
  artifact: ArtifactRefSchema,
});

/**
 * An applied patch.
 *
 * The two variants keep `dryRun` and the new reference in step: a persisted
 * result always names its revision, and a dry run can never appear to have
 * produced one.
 */
export const ArtifactPatchSuccessSchema = z.discriminatedUnion('dryRun', [
  ArtifactPatchDryRunSchema,
  ArtifactPatchPersistedSchema,
]);

/**
 * A rejected patch.
 *
 * A rejection by the engine — an undeclared path, an unmatched filter, a result
 * the kind schema refuses — and a `BASE_REVISION_CONFLICT`, whether the stale
 * base revision was caught before the write or the store refused it, all
 * guarantee that nothing was persisted. `HOST_FAILED` does not: a host that
 * failed while persisting may have committed the write before the failure
 * surfaced, so the outcome is unknown and the caller must re-read before
 * retrying. The error's `repair` says which case this is.
 */
export const ArtifactPatchFailureSchema = z.strictObject({
  ok: z.literal(false),
  error: ArtifactPatchErrorSchema,
});

/**
 * Outcome of a patch request.
 *
 * Rejections are in-band results rather than transport errors: they are the
 * expected way an agent learns which path to correct, and they must survive the
 * MCP facade unchanged.
 */
export const ArtifactPatchResponseSchema = z.union([ArtifactPatchSuccessSchema, ArtifactPatchFailureSchema]);

/** One array filter entry restricted to equality matching. */
export type ArtifactPatchArrayFilter = z.infer<typeof ArtifactPatchArrayFilterSchema>;
/** A complete patch document. */
export type ArtifactPatchDocument = z.infer<typeof ArtifactPatchDocumentSchema>;
/** Artifact identity addressed by a patch request. */
export type ArtifactPatchTarget = z.infer<typeof ArtifactPatchTargetSchema>;
/** Request payload for one patch-based artifact revision. */
export type ArtifactPatchRequest = z.infer<typeof ArtifactPatchRequestSchema>;
/** Stable failure classification for a patch request. */
export type ArtifactPatchErrorCode = (typeof ARTIFACT_PATCH_ERROR_CODES)[number];
/** One schema rejection of a patched result. */
export type ArtifactPatchIssue = z.infer<typeof ArtifactPatchIssueSchema>;
/** A rejected patch request. */
export type ArtifactPatchError = z.infer<typeof ArtifactPatchErrorSchema>;
/** What one applied instruction did. */
export type ArtifactPatchOperationResult = z.infer<typeof ArtifactPatchOperationResultSchema>;
/** An applied patch outcome. */
export type ArtifactPatchSuccess = z.infer<typeof ArtifactPatchSuccessSchema>;
/** Outcome of a patch request. */
export type ArtifactPatchResponse = z.infer<typeof ArtifactPatchResponseSchema>;
