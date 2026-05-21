import type { MakaioBusContext } from '../types/index.js';
import { isRequestSchema } from './is-request-schema.js';
import { validateSchema } from './validate-schema.js';

/**
 * Validates an event payload against its registered schema.
 * Handles the full validation ceremony: config lookup, schema lookup, and validation.
 * @param context - Makaio bus context
 * @param fullSubjectKey - Full subject key (namespace.subject)
 * @param payload - Event payload to validate
 * @throws ValidationError If validation fails in strict mode
 */
export function validateEventPayload(context: MakaioBusContext, fullSubjectKey: string, payload: unknown): void {
  const { mode, onViolation } = context.namespaceRegistry.getValidationConfig(fullSubjectKey);
  if (mode === 'skip') return;

  const schema = context.namespaceRegistry.getSchema(fullSubjectKey);
  if (!schema || isRequestSchema(schema)) return;

  validateSchema(fullSubjectKey, payload, schema, mode, onViolation);
}
