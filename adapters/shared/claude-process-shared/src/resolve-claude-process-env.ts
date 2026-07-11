import { normalizeEnvValue } from '@makaio/ai-adapters-core';

/** Claude process environment variable used for Anthropic-compatible endpoint overrides. */
export const CLAUDE_BASE_URL_ENV = 'ANTHROPIC_BASE_URL';

/**
 * Inputs for applying non-secret Claude process environment configuration.
 */
export interface ResolveClaudeProcessEnvOptions {
  /** Final auth-selected environment produced by AdapterAuthRuntime. */
  spawnEnv: Record<string, string>;
  /** Anthropic-compatible endpoint selected by the adapter config factory. */
  baseUrl?: string;
}

/**
 * Read a resolved `baseUrl` field from a providerConfig object.
 *
 * Adapter config factories add `baseUrl` generically based on provider endpoint
 * overrides. Some adapter-specific providerConfig types do not declare that
 * generic field, so callers use this narrow reader instead of widening their
 * providerConfig contracts.
 * @param providerConfig - Provider config value produced by an adapter config factory
 * @returns Trimmed base URL when present
 */
export function readClaudeProviderBaseUrl(providerConfig: unknown): string | undefined {
  if (!providerConfig || typeof providerConfig !== 'object') return undefined;
  const value = (providerConfig as { baseUrl?: unknown }).baseUrl;
  return typeof value === 'string' ? normalizeEnvValue(value) : undefined;
}

/**
 * Apply the provider endpoint to an already-finalized Claude process environment.
 *
 * Authentication is deliberately absent: AdapterAuthRuntime owns source
 * resolution, competing-variable scrubbing, and selected process delivery.
 * This helper may only add the non-secret endpoint override.
 * @param options - Finalized process environment plus provider base URL
 * @returns Spawn environment ready for Claude process execution
 */
export function resolveClaudeProcessEnv(options: ResolveClaudeProcessEnvOptions): Record<string, string> {
  const env = { ...options.spawnEnv };
  delete env[CLAUDE_BASE_URL_ENV];

  const baseUrl = normalizeEnvValue(options.baseUrl);
  if (baseUrl) {
    env[CLAUDE_BASE_URL_ENV] = baseUrl;
  }

  return env;
}
