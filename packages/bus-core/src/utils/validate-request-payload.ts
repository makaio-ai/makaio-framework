import type { z } from 'zod';
import type { MakaioBusContext } from '../types/index.js';
import { isRequestSchema } from './is-request-schema.js';
import { validateSchema } from './validate-schema.js';
import type { ValidationConfig } from '../registries/namespace-registry.js';

/**
 * Cached validation config for a request subject.
 * Resolved once per request call and reused for both request and response validation.
 */
export interface RequestValidationContext extends ValidationConfig {
  /** Zod schema for request payload, if registered */
  requestSchema: z.ZodType | undefined;
  /** Zod schema for response payload, if registered */
  responseSchema: z.ZodType | undefined;
}

/**
 * Resolves the validation context for a request subject.
 * Call once per request, then pass to validateRequestPayload/validateResponsePayload.
 * @param context - Makaio bus context
 * @param fullSubjectKey - Full subject key (namespace.subject)
 * @returns Validation context with schemas and mode
 */
export function resolveRequestValidation(context: MakaioBusContext, fullSubjectKey: string): RequestValidationContext {
  const { mode, onViolation } = context.namespaceRegistry.getValidationConfig(fullSubjectKey);
  if (mode === 'skip') {
    return { requestSchema: undefined, responseSchema: undefined, mode, onViolation: undefined };
  }

  const schema = context.namespaceRegistry.getSchema(fullSubjectKey);
  if (!schema || !isRequestSchema(schema)) {
    return { requestSchema: undefined, responseSchema: undefined, mode, onViolation };
  }

  return { requestSchema: schema.request, responseSchema: schema.response, mode, onViolation };
}

/**
 * Validates a request payload using pre-resolved validation context.
 * @param fullSubjectKey - Full subject key for error messages
 * @param payload - Request payload to validate
 * @param validationCtx - Pre-resolved validation context
 * @throws ValidationError If validation fails in strict mode
 */
export function validateRequestPayload(
  fullSubjectKey: string,
  payload: unknown,
  validationCtx: RequestValidationContext,
): void {
  if (validationCtx.requestSchema) {
    validateSchema(fullSubjectKey, payload, validationCtx.requestSchema, validationCtx.mode, validationCtx.onViolation);
  }
}

/**
 * Validates a response payload using pre-resolved validation context.
 * @param fullSubjectKey - Full subject key for error messages
 * @param payload - Response payload to validate
 * @param validationCtx - Pre-resolved validation context
 * @throws ValidationError If validation fails in strict mode
 */
export function validateResponsePayload(
  fullSubjectKey: string,
  payload: unknown,
  validationCtx: RequestValidationContext,
): void {
  if (validationCtx.responseSchema) {
    validateSchema(
      fullSubjectKey,
      payload,
      validationCtx.responseSchema,
      validationCtx.mode,
      validationCtx.onViolation,
    );
  }
}
