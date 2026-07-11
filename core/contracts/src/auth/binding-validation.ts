import type { AdapterAuthBinding } from './adapter-binding.js';

/** Credential-field subset required for delivery-semantic validation. */
interface AdapterAuthBindingCredentialFieldDefinition {
  readonly id: string;
  readonly required: boolean;
}

/** Static auth method accepted by adapter binding validation. */
export type AdapterAuthBindingMethodDefinition =
  | {
      readonly id: string;
      readonly mode: 'explicit';
      readonly fields: readonly AdapterAuthBindingCredentialFieldDefinition[];
    }
  | {
      readonly id: string;
      readonly mode: 'inferred' | 'none';
    };

/** Stable semantic failure categories for an adapter auth binding. */
type AdapterAuthBindingValidationCode =
  | 'method-mismatch'
  | 'delivery-mode-mismatch'
  | 'native-client-mismatch'
  | 'unknown-field'
  | 'required-field-undelivered'
  | 'process-target-collision'
  | 'connector-target-collision'
  | 'connector-value-target-collision';

/** Typed failure produced by the pure binding-vs-method validator. */
class AdapterAuthBindingValidationError extends Error {
  /**
   * Create a credential-free binding validation failure.
   * @param code - Stable semantic validation category.
   * @param message - Human-readable declaration diagnostic.
   */
  public constructor(
    public readonly code: AdapterAuthBindingValidationCode,
    message: string,
  ) {
    super(message);
    this.name = 'AdapterAuthBindingValidationError';
  }
}

/**
 * Assert that one adapter binding can faithfully deliver one static auth method.
 *
 * This is the single semantic validator shared by contribution discovery, UI
 * compatibility reads, and Adapter Core. Structural Zod parsing remains the
 * responsibility of the surrounding declaration contract.
 * @param binding - Structurally valid adapter delivery binding.
 * @param method - Authoritative provider/client auth method definition.
 */
export function assertAdapterAuthBindingMatchesMethod(
  binding: AdapterAuthBinding,
  method: AdapterAuthBindingMethodDefinition,
): void {
  if (binding.method.methodId !== method.id) {
    throw new AdapterAuthBindingValidationError(
      'method-mismatch',
      `Adapter authentication binding method "${binding.method.methodId}" does not match definition "${method.id}".`,
    );
  }

  assertDeliveryMode(binding, method);
  if (method.mode !== 'explicit') return;

  const knownFieldIds = new Set(method.fields.map((field) => field.id));
  const deliveredFieldIds = new Set<string>();
  const processTargets = new Set<string>();
  const connectorTargets = new Set<string>();

  for (const delivery of binding.deliveries) {
    if (delivery.kind === 'process-env') {
      for (const [fieldId, target] of Object.entries(delivery.fields)) {
        assertKnownField(knownFieldIds, fieldId);
        deliveredFieldIds.add(fieldId);
        assertUniqueTarget(processTargets, target, 'process-target-collision', 'process environment');
      }
      continue;
    }

    if (delivery.kind !== 'connector') continue;

    assertUniqueTarget(connectorTargets, delivery.target, 'connector-target-collision', 'connector operation');
    const valueTargets = new Set<string>();
    for (const [fieldId, target] of Object.entries(delivery.fields)) {
      assertKnownField(knownFieldIds, fieldId);
      deliveredFieldIds.add(fieldId);
      assertUniqueTarget(
        valueTargets,
        target,
        'connector-value-target-collision',
        `connector operation "${delivery.target}" value`,
      );
    }
    for (const target of Object.keys(delivery.constants ?? {})) {
      assertUniqueTarget(
        valueTargets,
        target,
        'connector-value-target-collision',
        `connector operation "${delivery.target}" value`,
      );
    }
  }

  for (const field of method.fields) {
    if (field.required && !deliveredFieldIds.has(field.id)) {
      throw new AdapterAuthBindingValidationError(
        'required-field-undelivered',
        `Required authentication field "${field.id}" has no adapter delivery.`,
      );
    }
  }
}

/**
 * Require each auth mode to use its legal delivery family.
 * @param binding - Adapter delivery binding.
 * @param method - Authoritative auth method definition.
 */
function assertDeliveryMode(binding: AdapterAuthBinding, method: AdapterAuthBindingMethodDefinition): void {
  if (method.mode === 'explicit') {
    if (binding.deliveries.some(({ kind }) => kind !== 'process-env' && kind !== 'connector')) {
      throw new AdapterAuthBindingValidationError(
        'delivery-mode-mismatch',
        'Explicit authentication requires process-environment or connector deliveries.',
      );
    }
    return;
  }

  if (method.mode === 'inferred') {
    const delivery = binding.deliveries[0];
    if (binding.deliveries.length !== 1 || delivery?.kind !== 'native-client') {
      throw new AdapterAuthBindingValidationError(
        'delivery-mode-mismatch',
        'Inferred authentication requires exactly one native-client delivery.',
      );
    }
    if (binding.method.owner !== 'client' || binding.method.clientId !== delivery.clientId) {
      throw new AdapterAuthBindingValidationError(
        'native-client-mismatch',
        'Native-client delivery must target the client that owns the bound auth method.',
      );
    }
    return;
  }

  if (binding.deliveries.length !== 1 || binding.deliveries[0]?.kind !== 'none') {
    throw new AdapterAuthBindingValidationError(
      'delivery-mode-mismatch',
      'No-authentication methods require exactly one none delivery.',
    );
  }
}

/**
 * Require a delivery source field to exist on the explicit method.
 * @param knownFieldIds - Field identifiers declared by the method.
 * @param fieldId - Delivery source field identifier.
 */
function assertKnownField(knownFieldIds: ReadonlySet<string>, fieldId: string): void {
  if (!knownFieldIds.has(fieldId)) {
    throw new AdapterAuthBindingValidationError(
      'unknown-field',
      `Adapter authentication delivery references unknown field "${fieldId}".`,
    );
  }
}

/**
 * Reject assignment-order-dependent delivery target collisions.
 * @param seenTargets - Targets already used in the current namespace.
 * @param target - Target about to be registered.
 * @param code - Stable collision category.
 * @param targetKind - Human-readable target namespace.
 */
function assertUniqueTarget(
  seenTargets: Set<string>,
  target: string,
  code: Extract<
    AdapterAuthBindingValidationCode,
    'process-target-collision' | 'connector-target-collision' | 'connector-value-target-collision'
  >,
  targetKind: string,
): void {
  if (seenTargets.has(target)) {
    throw new AdapterAuthBindingValidationError(
      code,
      `Adapter authentication has duplicate ${targetKind} target "${target}".`,
    );
  }
  seenTargets.add(target);
}
