import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { JsonValueSchema, type JsonValue } from '../shared/json-value.js';
import { ARTIFACT_VALUE_TYPE_KEYWORD } from './evidence.js';
import type { ArtifactKindRegistration } from './kind-registration.js';

/** Validates one artifact payload against its registered JSON Schema. */
export type ArtifactDataValidator = (data: unknown) => boolean;

/** One rejected location within an artifact payload, with what the schema expected there. */
export interface ArtifactDataIssue {
  /** Dot-separated data-relative path of the rejected value; empty for the payload root. */
  readonly path: string;
  /** What the schema expected at that path. */
  readonly reason: string;
  /** Declared type at that path, when the rejection names one. */
  readonly expectedType?: string;
  /** Declared value set at that path, when the rejection names one. */
  readonly allowedValues?: readonly JsonValue[];
}

/** Complete outcome of checking one artifact payload. */
export type ArtifactDataCheck =
  | { readonly valid: true }
  | { readonly valid: false; readonly issues: readonly ArtifactDataIssue[] };

/** Checks one artifact payload and reports every rejected location. */
export type ArtifactDataChecker = (data: unknown) => ArtifactDataCheck;

/**
 * Compile the JSON Schema declared by one artifact kind.
 *
 * Each invocation creates an isolated compiler so local schema identifiers
 * cannot satisfy references belonging to another kind.
 * @param registration - Structurally validated artifact kind registration.
 * @returns The compiled validation function, carrying the errors of its last call.
 * @throws When the declared data schema cannot be compiled by its supported dialect.
 */
function compile(registration: ArtifactKindRegistration): ValidateFunction {
  const options = { allErrors: true, strict: false, strictSchema: true };
  const compiler =
    registration.dataSchema.$schema === 'https://json-schema.org/draft/2020-12/schema'
      ? new Ajv2020(options)
      : new Ajv(options);
  addFormats(compiler);
  compiler.addKeyword({ keyword: ARTIFACT_VALUE_TYPE_KEYWORD, schemaType: 'string', valid: true });
  return compiler.compile(registration.dataSchema);
}

/**
 * Convert one JSON Pointer token back to the property name it encodes.
 * @param token - Pointer token as it appears between separators.
 * @returns The decoded property name.
 */
function decodePointerToken(token: string): string {
  return token.replace(/~1/gu, '/').replace(/~0/gu, '~');
}

/**
 * Locate a rejection within the payload.
 *
 * A missing or surplus property is reported against the property itself rather
 * than the object that should or should not hold it, because the property name
 * is what the caller has to act on.
 * @param error - One validation error.
 * @returns Dot-separated data-relative path; empty for the payload root.
 */
function issuePath(error: ErrorObject): string {
  const segments = error.instancePath.split('/').slice(1).map(decodePointerToken);
  const named = error.keyword === 'required' ? error.params.missingProperty : error.params.additionalProperty;
  if (typeof named === 'string' && (error.keyword === 'required' || error.keyword === 'additionalProperties')) {
    segments.push(named);
  }
  return segments.join('.');
}

/**
 * Name the type a rejection declares, including union declarations.
 * @param error - One validation error.
 * @returns The declared type, or undefined when the rejection names none.
 */
function expectedType(error: ErrorObject): string | undefined {
  if (error.keyword !== 'type') return undefined;
  const declared: unknown = error.params.type;
  if (typeof declared === 'string') return declared;
  if (Array.isArray(declared) && declared.every((entry) => typeof entry === 'string')) return declared.join(' | ');
  return undefined;
}

/** Enum operands come from an already-validated JSON Schema document, so they parse as JSON. */
const AllowedValuesSchema = JsonValueSchema.array();

/**
 * Name the value set a rejection declares.
 * @param error - One validation error.
 * @returns The declared values, or undefined when the rejection names none.
 */
function allowedValues(error: ErrorObject): readonly JsonValue[] | undefined {
  if (error.keyword !== 'enum') return undefined;
  const parsed = AllowedValuesSchema.safeParse(error.params.allowedValues);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Describe every rejection reported by the last validation call.
 * @param errors - Validation errors, or null when the compiler reported none.
 * @returns One issue per rejection, in the order the compiler produced them.
 */
function toIssues(errors: ErrorObject[] | null | undefined): ArtifactDataIssue[] {
  return (errors ?? []).map((error) => {
    const type = expectedType(error);
    const values = allowedValues(error);
    return {
      path: issuePath(error),
      reason: error.message ?? `violates ${error.keyword}`,
      ...(type === undefined ? {} : { expectedType: type }),
      ...(values === undefined ? {} : { allowedValues: values }),
    };
  });
}

/**
 * Compile a predicate for complete artifact payload validation.
 *
 * The predicate hides the compiled function's mutable `errors`, so a caller
 * cannot read error state left behind by an unrelated call. Use
 * {@link compileArtifactDataChecker} when the rejections themselves are needed.
 * @param registration - Structurally validated artifact kind registration.
 * @returns A predicate for complete artifact payload validation.
 * @throws When the declared data schema cannot be compiled by its supported dialect.
 */
export function compileArtifactDataSchema(registration: ArtifactKindRegistration): ArtifactDataValidator {
  return compile(registration);
}

/**
 * Compile a checker that reports why an artifact payload was rejected.
 *
 * Use this where the caller has to repair the payload rather than merely learn
 * that it is invalid: each issue names a path and, where the schema declares
 * one, the expected type or the allowed values.
 *
 * The returned checker owns its compiled function and reads that function's
 * errors before returning, so concurrent callers each need their own checker.
 * @param registration - Structurally validated artifact kind registration.
 * @returns A checker producing one issue per rejected location.
 * @throws When the declared data schema cannot be compiled by its supported dialect.
 */
export function compileArtifactDataChecker(registration: ArtifactKindRegistration): ArtifactDataChecker {
  const validate = compile(registration);
  return (data: unknown): ArtifactDataCheck =>
    validate(data) ? { valid: true } : { valid: false, issues: toIssues(validate.errors) };
}
