import { normalizeEnvValue } from '@makaio/ai-adapters-core';

/** Claude process environment variable used for API-key authentication. */
export const CLAUDE_API_KEY_ENV = 'ANTHROPIC_API_KEY';

/** Claude process environment variable used for Anthropic-compatible endpoint overrides. */
export const CLAUDE_BASE_URL_ENV = 'ANTHROPIC_BASE_URL';

interface ClaudeProviderContextShape {
  /** Provider definition ID, used only for debugging and future diagnostics. */
  definitionId?: string;
  /** Provider credential env vars keyed by credential field. */
  credentialEnvVars?: Record<string, string>;
  /** Protocol endpoint overrides resolved from the provider definition. */
  endpointOverrides?: { anthropic?: string };
}

/**
 * Inputs for translating Makaio provider credentials into the Claude process env contract.
 */
export interface ResolveClaudeProcessEnvOptions {
  /** Environment after generic subprocess cleanup and credential resolution. */
  spawnEnv: Record<string, string>;
  /** Plaintext credentials resolved from providerContext credentialRefs. */
  credentials: Record<string, string>;
  /** Provider context that supplied the credential env mapping. */
  providerContext?: ClaudeProviderContextShape;
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
 * Translate Makaio provider credentials into the env names consumed by Claude Code.
 *
 * Claude SDK/CLI processes do not understand provider-specific env names such
 * as `OPENCODE_GO_API_KEY`; they consume Anthropic-compatible env names. This
 * keeps the generic provider context intact while adapting at the fixed-client
 * boundary where the native env contract is known.
 * @param options - Generic resolved env plus provider credentials/base URL
 * @returns Spawn environment ready for Claude SDK/CLI process execution
 */
export function resolveClaudeProcessEnv(options: ResolveClaudeProcessEnvOptions): Record<string, string> {
  const env = { ...options.spawnEnv };
  delete env[CLAUDE_BASE_URL_ENV];

  for (const envVar of Object.values(options.providerContext?.credentialEnvVars ?? {})) {
    if (envVar !== CLAUDE_API_KEY_ENV) {
      delete env[envVar];
    }
  }

  const apiKey = normalizeEnvValue(options.credentials['apiKey']);
  if (apiKey) {
    env[CLAUDE_API_KEY_ENV] = apiKey;
  }

  const baseUrl =
    normalizeEnvValue(options.baseUrl) ?? normalizeEnvValue(options.providerContext?.endpointOverrides?.anthropic);
  if (baseUrl) {
    env[CLAUDE_BASE_URL_ENV] = baseUrl;
  }

  return env;
}
