import type { MakaioBusContext } from '@makaio/bus-core';
import type { CredentialRef } from '@makaio/contracts/config';
import type { ClientExecutionContext } from '@makaio/contracts/client';
import { resolveClientBinary } from '@makaio/subsystem-client';
import { resolveConnectorCredentials } from './resolve-connector-credentials.js';
import { buildCredentialEnv } from './build-credential-env.js';
import { cleanEnvForAdapter } from '../utils/cleanEnvForAdapter.js';

/** Minimal bus surface needed for session environment resolution. */
interface SessionEnvironmentBus {
  getContext(): MakaioBusContext;
}

/**
 * Unresolved provider context fields needed for session environment resolution.
 *
 * Mirrors the relevant subset of {@link ProviderContext} from `@makaio/contracts`
 * so callers can pass the full provider context object without importing it here.
 */
interface ProviderContextShape {
  /** Provider config UUID carried by full provider contexts. */
  providerConfigId?: string;
  /** Provider definition ID carried by full provider contexts. */
  definitionId?: string;
  /** Credential references keyed by field name. */
  credentialRefs: Record<string, CredentialRef>;
  /** Maps credential field names to env var names for subprocess adapters. */
  credentialEnvVars?: Record<string, string>;
  /** Ambient provider credential env vars to strip before explicit credential injection. */
  ambientCredentialEnvVars?: readonly string[];
}

/**
 * Input options for {@link resolveSessionEnvironment}.
 */
export interface SessionEnvironmentOptions {
  /** Bus instance used to resolve credential references. */
  bus: SessionEnvironmentBus;
  /**
   * Unresolved provider context carrying credential refs and env-var mapping.
   * When `undefined`, the credential steps are skipped and `credentials` / `credEnv`
   * are returned as empty objects.
   */
  providerContext: ProviderContextShape | undefined;
  /**
   * Stable client identifier passed to `resolveClientBinary`
   * (e.g. `'claude-code'`, `'qwen'`, `'github-copilot'`).
   */
  clientId: string;
  /**
   * Base environment variables that are merged into `spawnEnv` before credential
   * env and binary env are applied.  Typically the connector's own `this.env`.
   */
  baseEnv?: Record<string, string>;
}

/**
 * Fully resolved session environment returned by {@link resolveSessionEnvironment}.
 *
 * All three resolution steps are returned individually so callers that need
 * non-standard composition (e.g. optional binary env) can do so without
 * repeating the resolution calls.
 */
export interface SessionEnvironmentResult {
  /**
   * Plaintext credentials keyed by field name.
   * Empty when `providerContext` is `undefined` or carries no credential refs.
   */
  credentials: Record<string, string>;
  /**
   * Environment variables derived from `credentials` via the provider's
   * `credentialEnvVars` mapping.
   * Empty when `providerContext` is `undefined` or carries no `credentialEnvVars`.
   */
  credEnv: Record<string, string>;
  /**
   * Execution context for the resolved client binary, or `undefined` when
   * no `client.resolveBinary` handler is registered (framework-only boot).
   */
  resolvedBinary: ClientExecutionContext | undefined;
  /**
   * Merged spawn environment for the common case:
   * `{ ...cleanBaseEnv, ...credEnv, ...(resolvedBinary?.env ?? {}) }`.
   *
   * Ambient provider credential env vars are stripped from base env first.
   * Credential env then takes precedence so that explicitly resolved secrets are
   * restored. Binary env finally wins over credential env to enforce config
   * isolation.
   */
  spawnEnv: Record<string, string>;
}

/**
 * Resolve credentials, build credential environment variables, and locate the
 * client binary — the three-step pattern shared by subprocess connectors.
 *
 * Encapsulates:
 * 1. `resolveConnectorCredentials(bus, credentialRefs)` — opens an encrypted
 *    DirectChannel, resolves each ref, and closes the channel.
 * 2. `buildCredentialEnv(credentials, credentialEnvVars)` — maps credential
 *    values to subprocess env var names.
 * 3. `resolveClientBinary(clientId)` — dispatches `client.resolveBinary` on the
 *    static bus; returns `undefined` in framework-only boot.
 *
 * The returned {@link SessionEnvironmentResult} includes every intermediate
 * value so callers with non-standard composition strategies (e.g. connectors
 * that treat binary env as optional or pass credentials through a different
 * channel) can compose the final env themselves.
 * @param options - Session environment resolution options
 * @returns Resolved credentials, credential env, binary execution context, and
 *   merged spawn environment
 */
export async function resolveSessionEnvironment(options: SessionEnvironmentOptions): Promise<SessionEnvironmentResult> {
  const { bus, providerContext, clientId, baseEnv = {} } = options;

  const credentialRefs = providerContext?.credentialRefs ?? {};
  const credentials = await resolveConnectorCredentials(bus, credentialRefs);
  const credEnv = buildCredentialEnv(credentials, providerContext?.credentialEnvVars);
  const resolvedBinary = await resolveClientBinary(clientId);
  const cleanBaseEnv = cleanEnvForAdapter(baseEnv, {
    omitEnvVars: providerContext?.ambientCredentialEnvVars,
  });

  const spawnEnv: Record<string, string> = {
    ...cleanBaseEnv,
    ...credEnv,
    ...(resolvedBinary?.env ?? {}),
  };

  return { credentials, credEnv, resolvedBinary, spawnEnv };
}
