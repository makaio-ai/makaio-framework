import {
  compileJsonSchemaCheck,
  type JsonSchemaCheck,
  type JsonSchemaCheckResult,
  type JsonSchemaIssue,
} from '../shared/json-schema-check.js';
import { ARTIFACT_VALUE_TYPE_KEYWORD } from './evidence.js';
import type { ArtifactKindRegistration } from './kind-registration.js';
import { ARTIFACT_SLUG_FIELD, ARTIFACT_SLUG_RESERVED_MESSAGE } from './slug.js';

/** Validates one artifact payload against its registered JSON Schema. */
export type ArtifactDataValidator = (data: unknown) => boolean;

/** One rejected location within an artifact payload, with what the schema expected there. */
export type ArtifactDataIssue = JsonSchemaIssue;

/** Complete outcome of checking one artifact payload. */
export type ArtifactDataCheck = JsonSchemaCheckResult;

/** Checks one artifact payload and reports every rejected location. */
export type ArtifactDataChecker = (data: unknown) => ArtifactDataCheck;

/**
 * Compile the JSON Schema declared by one artifact kind.
 *
 * Each invocation creates an isolated compiler so local schema identifiers
 * cannot satisfy references belonging to another kind. The artifact-only
 * `x-makaio-value-type` keyword is registered as an annotation, never a
 * rejection.
 * @param registration - Structurally validated artifact kind registration.
 * @returns The compiled JSON Schema check for the kind's data schema.
 * @throws When the declared data schema cannot be compiled by its supported dialect.
 */
function compile(registration: ArtifactKindRegistration): JsonSchemaCheck {
  return compileJsonSchemaCheck(registration.dataSchema, {
    annotationKeywords: [ARTIFACT_VALUE_TYPE_KEYWORD],
  });
}

/**
 * Whether a payload carries the envelope-owned `slug` at its top level.
 *
 * Checked at payload time because an open object schema declares nothing about
 * `slug`, so the registration-time walker cannot reject the kind.
 * @param data - Candidate artifact payload.
 * @returns `true` when the payload is an object with an own `slug` property.
 */
function carriesReservedSlug(data: unknown): boolean {
  return typeof data === 'object' && data !== null && Object.hasOwn(data, ARTIFACT_SLUG_FIELD);
}

/** Issue reported for a top-level `data.slug`, in the same shape as a schema rejection. */
const RESERVED_SLUG_ISSUE: ArtifactDataIssue = { path: ARTIFACT_SLUG_FIELD, reason: ARTIFACT_SLUG_RESERVED_MESSAGE };

/**
 * Compile a predicate for complete artifact payload validation.
 *
 * The predicate hides the compiled check's internals, so a caller cannot read
 * error state left behind by an unrelated call. Use
 * {@link compileArtifactDataChecker} when the rejections themselves are needed.
 * @param registration - Structurally validated artifact kind registration.
 * @returns A predicate for complete artifact payload validation.
 * @throws When the declared data schema cannot be compiled by its supported dialect.
 */
export function compileArtifactDataSchema(registration: ArtifactKindRegistration): ArtifactDataValidator {
  const check = compile(registration);
  return (data: unknown): boolean => check(data).valid && !carriesReservedSlug(data);
}

/**
 * Compile a checker that reports why an artifact payload was rejected.
 *
 * Use this where the caller has to repair the payload rather than merely learn
 * that it is invalid: each issue names a path and, where the schema declares
 * one, the expected type or the allowed values.
 *
 * The returned checker owns its compiled check and reads that check's result
 * before returning, so concurrent callers each need their own checker.
 * @param registration - Structurally validated artifact kind registration.
 * @returns A checker producing one issue per rejected location.
 * @throws When the declared data schema cannot be compiled by its supported dialect.
 */
export function compileArtifactDataChecker(registration: ArtifactKindRegistration): ArtifactDataChecker {
  const check = compile(registration);
  return (data: unknown): ArtifactDataCheck => {
    const result = check(data);
    const issues = result.valid ? [] : [...result.issues];
    if (carriesReservedSlug(data)) issues.push(RESERVED_SLUG_ISSUE);
    return issues.length === 0 ? { valid: true } : { valid: false, issues };
  };
}
