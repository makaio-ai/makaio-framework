import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv';
import type { JsonValue, WorkflowDefinition } from '@makaio/contracts';

/** JSON Schema validator used for workflow state contracts. */
const ajv = new Ajv({ allErrors: true, strict: false });
const validatorCache = new Map<string, ValidateFunction>();
const schemaIdSignatures = new Map<string, string>();

/**
 * Return the JSON Schema `$id` when the state schema declares one.
 * @param schema - Workflow state JSON Schema document.
 * @returns Schema `$id`, or `undefined` when absent or non-string.
 */
function getWorkflowStateSchemaId(schema: Record<string, JsonValue>): string | undefined {
  const schemaId = schema.$id;
  return typeof schemaId === 'string' ? schemaId : undefined;
}

/**
 * Build a stable validator cache key for a workflow state schema.
 * @param workflowId - Workflow identifier used to scope anonymous schemas.
 * @param schema - Workflow state JSON Schema document.
 * @param signature - Serialized schema signature.
 * @returns Validator cache key.
 */
function buildWorkflowStateValidatorCacheKey(
  workflowId: string,
  schema: Record<string, JsonValue>,
  signature: string,
): string {
  const schemaId = getWorkflowStateSchemaId(schema);
  return schemaId === undefined ? `workflow:${workflowId}:${signature}` : `schema-id:${schemaId}`;
}

/**
 * Serialize a state schema for duplicate `$id` detection.
 * @param workflowId - Workflow identifier used in schema errors.
 * @param schema - Workflow state JSON Schema document.
 * @returns Serialized schema signature.
 */
function stringifyWorkflowStateSchema(workflowId: string, schema: Record<string, JsonValue>): string {
  try {
    return JSON.stringify(sortJsonValueForSignature(schema));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Workflow '${workflowId}' state schema is invalid: ${message}`);
  }
}

/**
 * Sort JSON object keys recursively while preserving array order.
 * @param value - JSON value to normalize for signature comparison.
 * @returns JSON value with deterministic object-key ordering.
 */
function sortJsonValueForSignature(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJsonValueForSignature);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const objectValue = value as Record<string, JsonValue>;
  return Object.fromEntries(
    Object.keys(objectValue)
      .sort()
      .map((key) => [key, sortJsonValueForSignature(objectValue[key] as JsonValue)]),
  );
}

/**
 * Resolve a cached validator for a schema with a JSON Schema `$id`.
 *
 * AJV registers `$id` globally on the instance. Recompiling a persisted workflow
 * snapshot with the same `$id` throws even when the schema is identical, so the
 * workflow state validator reuses the existing compiled validator for identical
 * `$id` schemas and rejects conflicting reuse explicitly.
 * @param workflowId - Workflow identifier used in schema errors.
 * @param schemaId - JSON Schema `$id`.
 * @param signature - Serialized schema signature.
 * @returns Cached validator when one already exists.
 */
function getCachedSchemaIdValidator(
  workflowId: string,
  schemaId: string,
  signature: string,
): ValidateFunction | undefined {
  const existingSignature = schemaIdSignatures.get(schemaId);
  if (existingSignature !== undefined && existingSignature !== signature) {
    throw new Error(
      `Workflow '${workflowId}' state schema reuses JSON Schema $id '${schemaId}' with different content`,
    );
  }
  return ajv.getSchema(schemaId);
}

/**
 * Format AJV validation errors for concise workflow state error messages.
 * @param errors - AJV error list from a failed validation.
 * @returns Human-readable validation summary.
 */
function formatWorkflowStateSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  if (errors === undefined || errors === null || errors.length === 0) {
    return 'schema validation failed';
  }
  return errors
    .map((error) => {
      const path = error.instancePath.length > 0 ? error.instancePath : '<root>';
      return `${path} ${error.message ?? 'is invalid'}`;
    })
    .join('; ');
}

/**
 * Compile a workflow state JSON Schema document.
 * @param workflowId - Workflow identifier used in schema compilation errors.
 * @param schema - JSON Schema declared by `workflow.state.schema`.
 * @returns Compiled AJV validator.
 */
function compileWorkflowStateValidator(workflowId: string, schema: Record<string, JsonValue>): ValidateFunction {
  const signature = stringifyWorkflowStateSchema(workflowId, schema);
  const cacheKey = buildWorkflowStateValidatorCacheKey(workflowId, schema, signature);
  const cached = validatorCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const schemaId = getWorkflowStateSchemaId(schema);
  if (schemaId !== undefined) {
    const schemaIdValidator = getCachedSchemaIdValidator(workflowId, schemaId, signature);
    if (schemaIdValidator !== undefined) {
      validatorCache.set(cacheKey, schemaIdValidator);
      return schemaIdValidator;
    }
  }
  try {
    const validator = ajv.compile(schema as AnySchema);
    validatorCache.set(cacheKey, validator);
    if (schemaId !== undefined) {
      schemaIdSignatures.set(schemaId, signature);
    }
    return validator;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Workflow '${workflowId}' state schema is invalid: ${message}`);
  }
}

/**
 * Validate a workflow state value against the workflow's declared state schema.
 *
 * No-ops when the workflow has no state contract.
 * @param workflow - Workflow definition carrying the optional state contract.
 * @param value - State value to validate.
 * @param phase - State lifecycle phase for the error message.
 */
export function assertWorkflowStateValueMatchesSchema(
  workflow: Pick<WorkflowDefinition, 'id' | 'state'>,
  value: JsonValue,
  phase: 'initial' | 'next',
): void {
  if (workflow.state === undefined) {
    return;
  }
  const validator = compileWorkflowStateValidator(workflow.id, workflow.state.schema);
  if (validator(value)) {
    return;
  }
  const label = phase === 'initial' ? 'initial state' : 'next state';
  throw new Error(
    `Workflow '${workflow.id}' ${label} does not match workflow state schema: ${formatWorkflowStateSchemaErrors(
      validator.errors,
    )}`,
  );
}

/**
 * Return a workflow's initial state value after schema validation.
 * @param workflow - Workflow definition carrying the optional state contract.
 * @returns Validated initial state value, or `undefined` when no state is declared.
 */
export function getValidatedInitialWorkflowState(
  workflow: Pick<WorkflowDefinition, 'id' | 'state'>,
): JsonValue | undefined {
  if (workflow.state === undefined) {
    return undefined;
  }
  const initialValue = workflow.state.initial === undefined ? {} : workflow.state.initial;
  assertWorkflowStateValueMatchesSchema(workflow, initialValue, 'initial');
  return initialValue;
}
