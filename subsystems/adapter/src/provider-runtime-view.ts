import type { IMakaioBus } from '@makaio/bus-core';
import {
  ResolvedProviderContextSchema,
  type ResolvedProviderAuth,
  type ResolvedProviderContext,
} from '@makaio/contracts';
import type {
  ClientAuthMethodDefinition,
  ProviderAuthMethodDefinition,
  ProviderConfigAuth,
} from '@makaio/contracts/auth';
import type { ProviderConfigFile } from '@makaio/contracts/config';
import type { ProviderRecord } from '@makaio/services-core/settings/storage';
import {
  assertProviderConfigAuthDefinitionsEnabled,
  ProviderConfigAuthValidationError,
  validateProviderConfigAuth,
} from './provider-config-auth-validation.js';

/** Stable runtime-context assembly failure categories. */
export type ProviderRuntimeContextErrorCode = 'provider-config-disabled';

/** Typed failure raised before a config can reach adapter startup. */
export class ProviderRuntimeContextError extends Error {
  /**
   * Create a runtime provider-context failure.
   * @param code - Stable failure category.
   * @param message - Credential-free diagnostic.
   */
  public constructor(
    public readonly code: ProviderRuntimeContextErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderRuntimeContextError';
  }
}

/** Definition-backed pieces derived from one provider runtime lookup. */
export interface ProviderRuntimeContextView {
  /** Refs-only context assembled from the captured provider config. */
  readonly context: ResolvedProviderContext;
  /** Exact provider definition used to validate and assemble the context. */
  readonly definition: ProviderRecord;
}

/**
 * Build a resolved provider context from one captured provider-config snapshot.
 *
 * The selected auth method is validated against provider/client definition
 * storage before the refs-only context is emitted. Invalid, disabled, or
 * dangling configs fail here and never become an inferred/ambient fallback.
 * @param bus - Bus used to resolve provider/client definition metadata.
 * @param providerConfigId - Provider config identifier.
 * @param raw - Raw canonical provider-config file from the captured snapshot.
 * @returns Validated refs-only context plus the exact provider definition used.
 */
export async function buildProviderRuntimeContextFromRaw(
  bus: IMakaioBus,
  providerConfigId: string,
  raw: ProviderConfigFile,
): Promise<ProviderRuntimeContextView> {
  if (raw.enabled === false) {
    throw new ProviderRuntimeContextError(
      'provider-config-disabled',
      `ProviderConfig '${providerConfigId}' is disabled and cannot be used for adapter startup.`,
    );
  }

  const validated = await validateProviderConfigAuth(bus, raw.definitionId, raw.auth);
  assertProviderConfigAuthDefinitionsEnabled(validated);
  const auth = buildResolvedProviderAuth(raw.auth, validated.method);
  const endpointOverrides = { ...(validated.provider.endpoints ?? {}), ...(raw.endpointOverrides ?? {}) };

  const context = ResolvedProviderContextSchema.parse({
    state: 'resolved',
    providerConfigId,
    definitionId: validated.provider.id,
    ...(Object.keys(endpointOverrides).length > 0 ? { endpointOverrides } : {}),
    auth,
    ...(validated.provider.capabilities ? { capabilities: validated.provider.capabilities } : {}),
  });

  return {
    context,
    definition: structuredClone(validated.provider),
  };
}

/**
 * Resolve the validated static method into the refs-only runtime auth union.
 * @param auth - Persisted normalized auth selection.
 * @param method - Exact definition-backed method selected by the config.
 * @returns Runtime auth selection with the static definition attached.
 */
function buildResolvedProviderAuth(
  auth: ProviderConfigAuth,
  method: ProviderAuthMethodDefinition | ClientAuthMethodDefinition,
): ResolvedProviderAuth {
  switch (auth.mode) {
    case 'explicit':
      if (method.mode !== 'explicit') {
        throw impossibleModeMismatch(auth.mode, method.mode);
      }
      return {
        mode: auth.mode,
        method: { ...auth.method },
        definition: structuredClone(method),
        credentialRefs: { ...auth.credentialRefs },
      };
    case 'inferred':
      if (method.mode !== 'inferred') {
        throw impossibleModeMismatch(auth.mode, method.mode);
      }
      return {
        mode: auth.mode,
        method: { ...auth.method },
        definition: { ...method },
        ...(auth.account ? { account: { ...auth.account } } : {}),
      };
    case 'none':
      if (method.mode !== 'none') {
        throw impossibleModeMismatch(auth.mode, method.mode);
      }
      return {
        mode: auth.mode,
        method: { ...auth.method },
        definition: { ...method },
      };
  }
}

/**
 * Build the defensive failure used when validation and assembly ever diverge.
 * @param selectedMode - Persisted selected mode.
 * @param declaredMode - Definition-declared mode.
 * @returns Typed auth-validation error without credential material.
 */
function impossibleModeMismatch(
  selectedMode: ProviderConfigAuth['mode'],
  declaredMode: ProviderAuthMethodDefinition['mode'] | ClientAuthMethodDefinition['mode'],
): ProviderConfigAuthValidationError {
  return new ProviderConfigAuthValidationError(
    'auth-mode-mismatch',
    `Validated authentication mode changed during context assembly: selected "${selectedMode}", declared "${declaredMode}".`,
  );
}
