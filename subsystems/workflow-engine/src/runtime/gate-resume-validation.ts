import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import type { JsonValue, WorkflowGateInstance } from '@makaio/contracts';

/** JSON Schema validator used for persisted gate resume contracts. */
const ajv = new Ajv({ allErrors: true, strict: false });

/** Compiled gate resume schema validation result. */
export type GateResumeValidatorCompileResult =
  | { readonly status: 'ok'; readonly validator?: ValidateFunction }
  | { readonly status: 'failed'; readonly error: string };

/** Gate resume payload validation result. */
export type GateResumeDataValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly error: string };

/**
 * Compile a gate's JSON Schema resume contract.
 * @param gateId - Gate node identifier used in error messages.
 * @param schema - Optional JSON Schema document for the gate resume payload.
 * @returns Compiled validator, or a failed result for invalid schema documents.
 */
export function compileGateResumeValidator(
  gateId: string,
  schema: WorkflowGateInstance['schema'] | undefined,
): GateResumeValidatorCompileResult {
  if (schema === undefined) {
    return { status: 'ok' };
  }
  try {
    return { status: 'ok', validator: ajv.compile(schema) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'failed', error: `Gate '${gateId}' has an invalid resumeSchema: ${message}` };
  }
}

/**
 * Validate resume data against a compiled gate resume schema, when declared.
 * @param validator - Compiled JSON Schema validator, if the gate declared one.
 * @param resumeData - Submitted resume payload.
 * @returns Validation outcome and a human-readable error when invalid.
 */
export function validateGateResumeData(
  validator: ValidateFunction | undefined,
  resumeData: JsonValue,
): GateResumeDataValidationResult {
  if (validator === undefined) {
    return { valid: true };
  }
  if (validator(resumeData)) {
    return { valid: true };
  }
  return { valid: false, error: formatAjvErrors(validator.errors ?? []) };
}

/**
 * Validate resume data directly against a persisted gate schema.
 * @param gateId - Gate node identifier used in schema compilation errors.
 * @param schema - Persisted gate resume schema.
 * @param resumeData - Submitted resume payload.
 * @returns Validation outcome and a human-readable error when invalid.
 */
export function validateGateResumeDataForSchema(
  gateId: string,
  schema: WorkflowGateInstance['schema'] | undefined,
  resumeData: JsonValue,
): GateResumeDataValidationResult {
  const resumeValidator = compileGateResumeValidator(gateId, schema);
  if (resumeValidator.status === 'failed') {
    return { valid: false, error: resumeValidator.error };
  }
  return validateGateResumeData(resumeValidator.validator, resumeData);
}

/**
 * Format AJV errors into a compact message suitable for node failure output.
 * @param errors - AJV validation errors.
 * @returns Joined validation error summary.
 */
function formatAjvErrors(errors: ErrorObject[]): string {
  if (errors.length === 0) {
    return 'schema validation failed';
  }
  return errors
    .map((error) => {
      const path = error.instancePath.length > 0 ? error.instancePath : '/';
      return `${path} ${error.message ?? 'is invalid'}`;
    })
    .join('; ');
}
