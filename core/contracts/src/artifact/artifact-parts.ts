/**
 * Declaration, validation and resolution of stably addressable artifact parts.
 *
 * An addressable part is one element of a declared array property whose local
 * identifier is stable within a revision. Callers address a part through a
 * local reference (artifact ref + localId), and the resolver maps that to the
 * verbatim element payload from the pinned revision.
 */
import { z } from 'zod';
import { ARTIFACT_COLLECTION_ELEMENT_SEGMENT, declaresType, inspectArtifactDataLocation } from './kind-paths.js';
import { isJsonObject, readPropertyPath } from '../shared/json-tree.js';
import type { ArtifactDataIssue } from './data-schema-validator.js';

// ──────────────────────────────────────────────────────────────────────────────
// Registration-time validation
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Structural subset of the kind registration payload inspected during
 * part-area validation. Mirrors the shape accepted by
 * `validateKindDataPaths` in kind-paths.ts so both validators can be called
 * from the same `superRefine` pass without import cycles.
 */
type PartAreaValidationInput = {
  readonly dataSchema: Record<string, unknown>;
  readonly addressableParts?: readonly { path: string; idPath: string }[];
};

/**
 * Validate declared addressable-part areas at registration time.
 *
 * Each area must select a declared array in every data schema variant, and its
 * `idPath` must select a required string in every element variant. Area paths
 * must be unique across all declared areas.
 *
 * Signature mirrors `validateKindDataPaths` so it can be called from the same
 * `superRefine` pass. This file must never import from `kind-registration.ts`
 * to avoid an import cycle; structural parameter types are used instead.
 * @param value - Kind registration payload to inspect.
 * @param ctx - Zod validation context for issuing actionable errors.
 */
export function validateArtifactPartAreas(value: PartAreaValidationInput, ctx: z.RefinementCtx): void {
  const areas = value.addressableParts;
  if (!areas || areas.length === 0) return;

  const seenPaths = new Set<string>();
  for (const [index, area] of areas.entries()) {
    if (seenPaths.has(area.path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['addressableParts', index, 'path'],
        message:
          `addressableParts[${index}].path duplicates an earlier area; ` +
          `each declared area must have a distinct path`,
      });
    }
    seenPaths.add(area.path);
    validatePartArea(value.dataSchema, area, index, ctx);
  }
}

/**
 * Validate one declared part area against the serialized data schema.
 * @param dataSchema - Serialized artifact data schema.
 * @param area - Declared area to inspect.
 * @param index - Zero-based index in `addressableParts` for diagnostic paths.
 * @param ctx - Zod validation context.
 */
function validatePartArea(
  dataSchema: Record<string, unknown>,
  area: { path: string; idPath: string },
  index: number,
  ctx: z.RefinementCtx,
): void {
  const areaFragments = inspectArtifactDataLocation(dataSchema, area.path.split('.'));
  if (!areaFragments || areaFragments.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['addressableParts', index, 'path'],
      message: `addressableParts[${index}].path must select a declared location ` + `in every data schema variant`,
    });
    return;
  }

  // This is a TYPE check only: the property may be optional in the data schema
  // (an absent array simply holds no parts at runtime).
  const hasNonArray = areaFragments.some((frag) => !declaresType(frag, 'array'));
  if (hasNonArray) {
    ctx.addIssue({
      code: 'custom',
      path: ['addressableParts', index, 'path'],
      message: `addressableParts[${index}].path must select an array schema in ` + `every data schema variant`,
    });
    return;
  }

  // Tuple shapes (prefixItems or array-valued items) are outside the
  // addressable-parts profile: the element token selects the homogeneous item
  // schema only; positional tuple slots cannot be addressed by local identifier.
  const hasTupleShape = areaFragments.some(
    (frag) => typeof frag === 'object' && (Array.isArray(frag.prefixItems) || Array.isArray(frag.items)),
  );
  if (hasTupleShape) {
    ctx.addIssue({
      code: 'custom',
      path: ['addressableParts', index, 'path'],
      message:
        `addressableParts[${index}].path selects a tuple schema; ` +
        `tuples are outside the addressable-parts profile (homogeneous arrays only)`,
    });
    return;
  }

  validatePartIdPath(dataSchema, area, index, ctx);
}

/**
 * Validate the `idPath` of one declared area against the element schema.
 *
 * The selected field must be a required string in every element variant.
 * Passes `requiredAfterElement: true` to `inspectArtifactDataLocation` so
 * that every segment below the element boundary — including intermediate
 * objects — is checked for requiredness in its enclosing schema's `required`
 * array. Segments above the element boundary (the area path) are exempt from
 * the required check, because the array property itself may be optional. A
 * single inspection call replaces the earlier two-step approach.
 * @param dataSchema - Serialized artifact data schema.
 * @param area - Declared area whose `idPath` is under inspection.
 * @param index - Zero-based index in `addressableParts` for diagnostic paths.
 * @param ctx - Zod validation context.
 */
function validatePartIdPath(
  dataSchema: Record<string, unknown>,
  area: { path: string; idPath: string },
  index: number,
  ctx: z.RefinementCtx,
): void {
  const idIssue = (): void => {
    ctx.addIssue({
      code: 'custom',
      path: ['addressableParts', index, 'idPath'],
      message: `addressableParts[${index}].idPath must select a required string ` + `in every element variant`,
    });
  };

  const idParts = area.idPath.split('.');
  const elementBase = [...area.path.split('.'), ARTIFACT_COLLECTION_ELEMENT_SEGMENT];

  // requiredAfterElement=true activates required-checking only for segments
  // below the element boundary ([]). Segments in the area path above []
  // are not checked — an array property may be optional. This catches
  // optional intermediate objects (e.g. idPath:'meta.id' when 'meta' is not
  // required in the element) without a separate parent-inspection step.
  const idFragments = inspectArtifactDataLocation(dataSchema, [...elementBase, ...idParts], {
    requiredAfterElement: true,
  });
  if (!idFragments || idFragments.length === 0) {
    idIssue();
    return;
  }
  const hasNonString = idFragments.some((frag) => !declaresType(frag, 'string'));
  if (hasNonString) {
    idIssue();
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Write-time payload check
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Check part identifier constraints in a live artifact payload.
 *
 * An area whose path is absent (or whose intermediate segments are absent)
 * contributes nothing — an absent array holds no parts. A present non-array
 * was already rejected by schema validation; one issue is emitted anyway to
 * surface the invariant violation at the concrete path.
 *
 * Identifiers are compared verbatim with no trimming or normalization; empty
 * and whitespace-only strings are rejected. Duplicate ids across all declared
 * areas emit one issue per duplicate, naming both concrete locations.
 * @param areas - Declared part areas for the artifact kind.
 * @param data - Artifact payload for one revision.
 * @returns Issues describing violated identifier invariants; empty on success.
 */
export function checkArtifactPartIds(
  areas: readonly { path: string; idPath: string }[],
  data: Record<string, unknown>,
): ArtifactDataIssue[] {
  const issues: ArtifactDataIssue[] = [];
  // Maps verbatim id value to the first concrete path where it was seen.
  const firstSeen = new Map<string, string>();

  for (const area of areas) {
    const areaValue = readPropertyPath(data, area.path.split('.'));
    if (areaValue === undefined) continue;
    if (!Array.isArray(areaValue)) {
      issues.push({
        path: area.path,
        reason: `declared part area must be an array; found ${typeof areaValue}`,
      });
      continue;
    }

    const idParts = area.idPath.split('.');
    for (const [elementIndex, element] of areaValue.entries()) {
      const idLocation = `${area.path}.${elementIndex}.${area.idPath}`;
      if (!isJsonObject(element)) {
        issues.push({
          path: idLocation,
          reason: 'part element is not an object; local identifier cannot be read',
        });
        continue;
      }

      const rawId = readPropertyPath(element, idParts);
      if (typeof rawId !== 'string') {
        issues.push({
          path: idLocation,
          reason:
            rawId === undefined
              ? 'local identifier is missing'
              : `local identifier must be a string; found ${typeof rawId}`,
        });
        continue;
      }
      // Verbatim check: reject empty strings and whitespace-only strings without
      // trimming or normalizing the value.
      if (/^\s*$/.test(rawId)) {
        issues.push({
          path: idLocation,
          reason: 'local identifier must be a non-empty, non-whitespace-only string',
        });
        continue;
      }

      const prior = firstSeen.get(rawId);
      if (prior !== undefined) {
        issues.push({
          path: idLocation,
          reason: `duplicate local identifier "${rawId}"; also found at ${prior}`,
        });
      } else {
        firstSeen.set(rawId, idLocation);
      }
    }
  }

  return issues;
}

/**
 * One relation source that does not identify exactly one declared part.
 *
 * `relationIndex` addresses the relation collection rather than artifact data:
 * callers own the wire path used to present this issue.
 */
export interface ArtifactRelationSourceIssue {
  /** Zero-based index of the rejected relation. */
  readonly relationIndex: number;
  /** Why the local source identifier did not resolve uniquely. */
  readonly reason: string;
}

/**
 * Check that every locally sourced relation resolves uniquely in one revision.
 *
 * Relations without `sourceLocalId` belong to the whole artifact and need no
 * part lookup. The supplied `data` is the containing revision's payload, so
 * this helper intentionally accepts no independent source revision pin.
 * @param areas - Declared part areas for the artifact kind.
 * @param data - Payload of the revision that stores the relations.
 * @param relations - Relations of that same revision, structurally typed to avoid import cycles.
 * @returns One issue for each local source that does not resolve uniquely.
 */
export function checkArtifactRelationSourceParts(
  areas: readonly { path: string; idPath: string }[],
  data: Record<string, unknown>,
  relations: readonly { readonly sourceLocalId?: string }[],
): ArtifactRelationSourceIssue[] {
  const issues: ArtifactRelationSourceIssue[] = [];
  const partsByLocalId = indexArtifactParts(areas, data);

  for (const [relationIndex, relation] of relations.entries()) {
    if (relation.sourceLocalId === undefined) continue;
    const resolution =
      partsByLocalId?.get(relation.sourceLocalId) ??
      (areas.length === 0
        ? { ok: false, reason: 'NO_PARTS_DECLARED' as const }
        : { ok: false, reason: 'PART_NOT_FOUND' as const });
    if (!resolution.ok) issues.push({ relationIndex, reason: resolution.reason });
  }

  return issues;
}

// ──────────────────────────────────────────────────────────────────────────────
// Error contract for artifact.resolvePart
// (request/response schemas live in part-resolution.ts — they embed the local
// reference schema, whose module transitively depends on this one)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Stable failure classifications for a part-resolution rejection.
 *
 * A subset mirrors `ArtifactPartResolution` reasons; additional codes cover
 * infrastructure-level failures (artifact or kind not found).
 */
export const ARTIFACT_RESOLVE_PART_ERROR_CODES = [
  /** No artifact exists at the requested reference. */
  'ARTIFACT_NOT_FOUND',
  /** The artifact kind has no registered schema. */
  'KIND_NOT_REGISTERED',
  /** The kind registration declares no addressable-part areas. */
  'NO_PARTS_DECLARED',
  /** No element in any declared area carries the requested local identifier. */
  'PART_NOT_FOUND',
  /**
   * More than one element across all areas carries the identifier. This is only
   * possible in historical revisions written before validation existed.
   */
  'DUPLICATE_LOCAL_ID',
] as const;

/** One stable failure code for a part-resolution rejection. */
export type ArtifactResolvePartErrorCode = (typeof ARTIFACT_RESOLVE_PART_ERROR_CODES)[number];

/**
 * Structured rejection for a part-resolution request.
 *
 * Every rejection carries a `repair` hint. The hint is required rather than
 * optional so it survives transport facades — a caller learns the next step
 * from the rejection itself regardless of which bus adapter or middleware
 * layer is in use. This follows the same contract established by
 * `ArtifactPatchErrorSchema` in patch.ts.
 */
export const ArtifactResolvePartErrorSchema = z.strictObject({
  /** Stable failure classification. */
  code: z.enum(ARTIFACT_RESOLVE_PART_ERROR_CODES),
  /** Human-readable explanation. */
  message: z.string().min(1),
  /** Concrete next step for the caller; required so repair hints survive facades. */
  repair: z.string().min(1),
});

/** Structured rejection for a part-resolution request. */
export type ArtifactResolvePartError = z.infer<typeof ArtifactResolvePartErrorSchema>;

// ──────────────────────────────────────────────────────────────────────────────
// Pure resolution
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Outcome of resolving one addressable artifact part by its local identifier.
 *
 * - `NO_PARTS_DECLARED` — the kind registration declares no addressable areas.
 * - `PART_NOT_FOUND` — no element carries the requested identifier.
 * - `DUPLICATE_LOCAL_ID` — more than one element carries it; this can only
 *   occur in historical revisions written before validation existed.
 */
export type ArtifactPartResolution =
  | { readonly ok: true; readonly areaPath: string; readonly part: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly reason: Extract<
        ArtifactResolvePartErrorCode,
        'NO_PARTS_DECLARED' | 'PART_NOT_FOUND' | 'DUPLICATE_LOCAL_ID'
      >;
    };

/**
 * Index every locally addressable part in one revision.
 *
 * A duplicate is retained as a failed resolution rather than choosing either
 * matching part. Both direct part resolution and relation validation therefore
 * retain the same ambiguity semantics while relation validation can reuse one
 * traversal for every carried relation.
 * @param areas - Declared part areas for the artifact kind.
 * @param data - Payload of the revision being indexed.
 * @returns An index by verbatim local identifier, or undefined when no parts are declared.
 */
function indexArtifactParts(
  areas: readonly { path: string; idPath: string }[],
  data: Record<string, unknown>,
): Map<string, ArtifactPartResolution> | undefined {
  if (areas.length === 0) return undefined;

  const partsByLocalId = new Map<string, ArtifactPartResolution>();
  for (const area of areas) {
    const areaValue = readPropertyPath(data, area.path.split('.'));
    if (!Array.isArray(areaValue)) continue;
    const idParts = area.idPath.split('.');
    for (const element of areaValue) {
      if (!isJsonObject(element)) continue;
      const rawId = readPropertyPath(element, idParts);
      if (typeof rawId !== 'string') continue;
      if (partsByLocalId.has(rawId)) {
        partsByLocalId.set(rawId, { ok: false, reason: 'DUPLICATE_LOCAL_ID' });
      } else {
        partsByLocalId.set(rawId, { ok: true, areaPath: area.path, part: element });
      }
    }
  }

  return partsByLocalId;
}

/**
 * Resolve one addressable artifact part by its local identifier.
 *
 * The function is pure: it processes the data it receives; callers guarantee
 * which revision the data comes from. When more than one element matches
 * (possible in historical revisions), the function returns `DUPLICATE_LOCAL_ID`
 * rather than picking one arbitrarily — callers must surface this as an error.
 * @param areas - Declared part areas for the artifact kind.
 * @param data - Artifact payload for the revision being resolved.
 * @param localId - Local identifier to look up; compared verbatim.
 * @returns Resolution outcome with the matching element payload on success.
 */
export function resolveArtifactPart(
  areas: readonly { path: string; idPath: string }[],
  data: Record<string, unknown>,
  localId: string,
): ArtifactPartResolution {
  const partsByLocalId = indexArtifactParts(areas, data);
  if (partsByLocalId === undefined) return { ok: false, reason: 'NO_PARTS_DECLARED' };
  return partsByLocalId.get(localId) ?? { ok: false, reason: 'PART_NOT_FOUND' };
}
