import type { ProviderDefinitionInput } from '@makaio/contracts';

/**
 * Resolve credentials from environment variables using a provider definition's credential mapping.
 *
 * Reads `definition.credentialEnvVars` and checks `process.env` for each declared variable.
 * Only includes fields where the env var is actually set.
 * @param definition - Provider definition with optional credentialEnvVars mapping
 * @returns Object mapping credential field names to resolved values, or undefined if none resolved
 */
export function resolvePresetCredentials(definition: ProviderDefinitionInput): Record<string, string> | undefined {
  if (!definition.credentialEnvVars) return undefined;

  const resolved: Record<string, string> = {};
  for (const [field, envVar] of Object.entries(definition.credentialEnvVars)) {
    const value = process.env[envVar];
    if (value !== undefined) {
      resolved[field] = value;
    }
  }

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}
