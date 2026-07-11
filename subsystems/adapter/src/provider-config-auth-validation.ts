import type { IMakaioBus } from '@makaio/bus-core';
import type {
  ClientAuthMethodDefinition,
  ProviderAuthMethodDefinition,
  ProviderConfigAuth,
} from '@makaio/contracts/auth';
import {
  ClientStorageSubjects,
  ProviderStorageSubjects,
  type ClientRecord,
  type ProviderRecord,
} from '@makaio/services-core/settings/storage';

/** Definition records captured while validating one auth selection. */
export interface ValidatedProviderConfigAuth {
  /** Exact declared method selected by the config. */
  readonly method: ProviderAuthMethodDefinition | ClientAuthMethodDefinition;
  /** Provider definition that owns the containing config. */
  readonly provider: ProviderRecord;
  /** Client definition when the selected method is client-owned. */
  readonly client?: ClientRecord;
}

/**
 * Require definition records selected by a structurally valid auth choice to
 * be enabled before the provider config can become executable.
 *
 * Disabled configs may retain structurally valid selections that reference a
 * disabled catalog record. The gate belongs at enable/runtime transitions so
 * drafts and managed desired state remain persistable without becoming usable.
 * @param validated - Definition records returned by structural auth validation.
 */
export function assertProviderConfigAuthDefinitionsEnabled(validated: ValidatedProviderConfigAuth): void {
  if (!validated.provider.enabled) {
    throw new ProviderConfigAuthValidationError(
      'provider-definition-disabled',
      `Provider definition is disabled for auth selection: ${validated.provider.id}`,
    );
  }
  if (validated.client !== undefined && !validated.client.enabled) {
    throw new ProviderConfigAuthValidationError(
      'client-definition-disabled',
      `Client definition is disabled for auth selection: ${validated.client.id}`,
    );
  }
}

/** Stable categories for definition-backed auth-selection validation. */
export type ProviderConfigAuthValidationCode =
  | 'provider-definition-not-found'
  | 'provider-definition-disabled'
  | 'client-definition-not-found'
  | 'client-definition-disabled'
  | 'auth-method-not-found'
  | 'auth-mode-mismatch'
  | 'auth-credential-fields-mismatch';

/** Typed validation failure for a provider-config auth selection. */
export class ProviderConfigAuthValidationError extends Error {
  /**
   * Create a definition-backed validation error.
   * @param code - Stable validation category.
   * @param message - Human-readable diagnostic that contains no credential values.
   */
  public constructor(
    public readonly code: ProviderConfigAuthValidationCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderConfigAuthValidationError';
  }
}

/**
 * Validate a normalized auth selection against provider/client definition
 * storage. No compatibility is inferred from provider IDs: client-owned
 * methods are resolved only from the referenced client definition.
 * @param bus - Bus used to read provider and client definitions.
 * @param definitionId - Provider definition selected by the containing config.
 * @param auth - Complete normalized auth selection.
 * @param knownProvider - Optional provider record already fetched by the caller.
 * @returns The validated method and definition records from one lookup snapshot.
 */
export async function validateProviderConfigAuth(
  bus: IMakaioBus,
  definitionId: string,
  auth: ProviderConfigAuth,
  knownProvider?: ProviderRecord,
): Promise<ValidatedProviderConfigAuth> {
  const provider = knownProvider ?? (await bus.request(ProviderStorageSubjects.get, { id: definitionId })).provider;
  if (!provider || provider.id !== definitionId) {
    throw new ProviderConfigAuthValidationError(
      'provider-definition-not-found',
      `Provider definition not found for auth selection: ${definitionId}`,
    );
  }
  let method: ProviderAuthMethodDefinition | ClientAuthMethodDefinition | undefined;
  let client: ClientRecord | null | undefined;
  if (auth.method.owner === 'provider') {
    if (auth.method.providerDefinitionId !== definitionId) {
      throw new ProviderConfigAuthValidationError(
        'auth-method-not-found',
        `Provider auth method "${auth.method.methodId}" does not belong to definition "${definitionId}".`,
      );
    }
    method = provider.authMethods.find(({ id }) => id === auth.method.methodId);
  } else {
    ({ client } = await bus.request(ClientStorageSubjects.get, { id: auth.method.clientId }));
    if (!client) {
      throw new ProviderConfigAuthValidationError(
        'client-definition-not-found',
        `Client definition not found for auth selection: ${auth.method.clientId}`,
      );
    }
    method = client.authMethods.find(({ id }) => id === auth.method.methodId);
  }

  if (!method) {
    const owner = auth.method.owner === 'provider' ? auth.method.providerDefinitionId : auth.method.clientId;
    throw new ProviderConfigAuthValidationError(
      'auth-method-not-found',
      `Authentication method "${auth.method.methodId}" is not declared by ${auth.method.owner} "${owner}".`,
    );
  }

  if (method.mode !== auth.mode) {
    throw new ProviderConfigAuthValidationError(
      'auth-mode-mismatch',
      `Authentication method "${method.id}" declares mode "${method.mode}", not "${auth.mode}".`,
    );
  }

  if (method.mode === 'explicit' && auth.mode === 'explicit') {
    validateExplicitCredentialFields(method, auth);
  }

  return { method, provider, ...(client ? { client } : {}) };
}

/**
 * Validate the exact credential-ref field set for one explicit method.
 * @param method - Declared explicit authentication method.
 * @param auth - Explicit persisted authentication selection.
 */
function validateExplicitCredentialFields(
  method: Extract<ProviderAuthMethodDefinition | ClientAuthMethodDefinition, { mode: 'explicit' }>,
  auth: Extract<ProviderConfigAuth, { mode: 'explicit' }>,
): void {
  const declaredFields = new Set(method.fields.map(({ id }) => id));
  const missingFields = method.fields
    .filter(({ id, required }) => required && auth.credentialRefs[id] === undefined)
    .map(({ id }) => id);
  const unexpectedFields = Object.keys(auth.credentialRefs).filter((fieldId) => !declaredFields.has(fieldId));

  if (missingFields.length === 0 && unexpectedFields.length === 0) {
    return;
  }

  const details = [
    ...(missingFields.length > 0 ? [`missing required fields [${missingFields.join(', ')}]`] : []),
    ...(unexpectedFields.length > 0 ? [`unexpected fields [${unexpectedFields.join(', ')}]`] : []),
  ];
  throw new ProviderConfigAuthValidationError(
    'auth-credential-fields-mismatch',
    `Authentication method "${method.id}" has ${details.join(' and ')}.`,
  );
}
