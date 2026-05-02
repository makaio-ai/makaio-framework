/**
 * Build environment variables from resolved credentials.
 *
 * Maps plaintext credential values to their environment variable names
 * using the provider definition's `credentialEnvVars` mapping. Subprocess
 * adapters use this to set the correct env vars before spawning.
 * @example
 * ```typescript
 * // { apiKey: 'sk-...' } + { apiKey: 'ANTHROPIC_API_KEY' }
 * // → { ANTHROPIC_API_KEY: 'sk-...' }
 * ```
 * @param credentials - Resolved plaintext credentials keyed by field name
 * @param credentialEnvVars - Mapping from credential field names to env var names
 * @returns Environment variables ready for process.env / subprocess spawn
 */
export function buildCredentialEnv(
  credentials: Record<string, string>,
  credentialEnvVars: Record<string, string> | undefined,
): Record<string, string> {
  if (!credentialEnvVars) {
    return {};
  }

  const env: Record<string, string> = {};
  for (const [field, envVar] of Object.entries(credentialEnvVars)) {
    const value = credentials[field];
    if (value !== undefined) {
      env[envVar] = value;
    }
  }
  return env;
}
