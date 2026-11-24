import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { JsonValueSchema, type JsonObject, type JsonValue } from './json-value.js';

/** One rejected location within a checked payload, with what the schema expected there. */
export interface JsonSchemaIssue {
  /** Dot-separated data-relative path of the rejected value; empty for the payload root. */
  readonly path: string;
  /** What the schema expected at that path. */
  readonly reason: string;
  /** Declared type at that path, when the rejection names one. */
  readonly expectedType?: string;
  /** Declared value set at that path, when the rejection names one. */
  readonly allowedValues?: readonly JsonValue[];
}

/** Complete outcome of checking one payload against a compiled JSON Schema. */
export type JsonSchemaCheckResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly issues: readonly JsonSchemaIssue[] };

/** Checks one payload against a compiled JSON Schema and reports every rejected location. */
export type JsonSchemaCheck = (data: unknown) => JsonSchemaCheckResult;

/** Options controlling how a JSON Schema document is compiled into a {@link JsonSchemaCheck}. */
export interface JsonSchemaCheckOptions {
  /**
   * Custom schema keywords accepted as annotations: declaring them never rejects a payload.
   * Each keyword is registered with a string schema type, matching how such annotations are
   * declared in the schema documents this module compiles.
   */
  readonly annotationKeywords?: readonly string[];
}

/**
 * Compile one JSON Schema document.
 *
 * Each invocation creates an isolated compiler so local schema identifiers
 * cannot satisfy references belonging to another document.
 * @param schema - JSON Schema document to compile (any JSON object; a `JsonSchema` value fits).
 * @param options - Compilation options.
 * @returns The compiled validation function, carrying the errors of its last call.
 * @throws When the schema cannot be compiled by its supported dialect.
 */
function compile(schema: JsonObject, options?: JsonSchemaCheckOptions): ValidateFunction {
  const ajvOptions = { allErrors: true, strict: false, strictSchema: true };
  const compiler =
    schema.$schema === 'https://json-schema.org/draft/2020-12/schema' ? new Ajv2020(ajvOptions) : new Ajv(ajvOptions);
  addFormats(compiler);
  for (const keyword of options?.annotationKeywords ?? []) {
    compiler.addKeyword({ keyword, schemaType: 'string', valid: true });
  }
  return compiler.compile(schema);
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
function toIssues(errors: ErrorObject[] | null | undefined): JsonSchemaIssue[] {
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
 * Compile a JSON Schema document into a reusable check.
 *
 * The returned check owns its compiled function and reads that function's
 * errors before returning, so concurrent callers each need their own check.
 * @param schema - JSON Schema document to compile (any JSON object; a `JsonSchema` value fits).
 * @param options - Compilation options.
 * @returns A check producing one issue per rejected location.
 * @throws When the schema cannot be compiled by its supported dialect.
 * @throws When the schema compiles to an asynchronous validator (declares `$async: true`):
 * {@link JsonSchemaCheck} is synchronous, so a schema needing async keywords (for example a
 * custom async format) can never be checked by it and is rejected at compile time instead of
 * misbehaving at every call.
 */
export function compileJsonSchemaCheck(schema: JsonObject, options?: JsonSchemaCheckOptions): JsonSchemaCheck {
  const validate = compile(schema, options);
  if ('$async' in validate && validate.$async === true) {
    throw new Error('Invalid JSON Schema: an asynchronous schema ($async: true) cannot back a synchronous check');
  }
  return (data: unknown): JsonSchemaCheckResult => {
    if (validate(data)) return { valid: true };
    return { valid: false, issues: toIssues(validate.errors) };
  };
}
