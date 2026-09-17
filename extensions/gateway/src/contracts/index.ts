/**
 * Public contract surface for the gateway extension.
 *
 * Re-exports all types, schemas, namespace definitions, and subjects that
 * downstream packages need when integrating with the gateway extension —
 * for example, to subscribe to routed-request events or to reference the
 * schema for validation.
 * @packageDocumentation
 */

export type { RequestOutcome, RequestRoutedEvent } from './schemas.js';
export { RequestOutcomeSchema, RequestRoutedEventSchema } from './schemas.js';
export { GatewayNamespace, GatewaySchemas, GatewaySubjects } from './namespace.js';
