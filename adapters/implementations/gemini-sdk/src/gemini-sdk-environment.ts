/**
 * Gemini CLI Core environment variables that can alter authentication or the
 * content-generator transport. They are cleared for every in-process SDK
 * initialization so a selected provider config is the only auth authority.
 */
export const GEMINI_SDK_SENSITIVE_ENV_VARS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_ACCESS_TOKEN',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT_ID',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_GENAI_USE_GCA',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GEMINI_BASE_URL',
  'GOOGLE_VERTEX_BASE_URL',
  'GOOGLE_GENAI_API_VERSION',
  'GEMINI_CLI_CUSTOM_HEADERS',
  'GEMINI_API_KEY_AUTH_MECHANISM',
  'CLOUD_SHELL',
  'GEMINI_CLI_USE_COMPUTE_ADC',
  'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
] as const;

export type GeminiSdkSensitiveEnvVar = (typeof GEMINI_SDK_SENSITIVE_ENV_VARS)[number];

/** The sole connector-selected SDK environment override. */
export const GEMINI_SYSTEM_SETTINGS_ENV = 'GEMINI_CLI_SYSTEM_SETTINGS_PATH' as const;

/** Explicit non-auth SDK environment values selected by connector configuration. */
export type GeminiSdkEnvironmentSelection = Readonly<Partial<Record<GeminiSdkSensitiveEnvVar, string>>>;

let environmentScopeTail: Promise<void> = Promise.resolve();

/**
 * Select the connector-owned SDK environment values from a sanitized connector environment.
 * @param env - Connector environment prepared by Adapter Core.
 * @returns Explicit values permitted inside the SDK scope.
 */
export function selectGeminiSdkEnvironment(env: Readonly<Record<string, string>>): GeminiSdkEnvironmentSelection {
  const systemSettingsPath = env[GEMINI_SYSTEM_SETTINGS_ENV];
  return systemSettingsPath === undefined ? {} : { [GEMINI_SYSTEM_SETTINGS_ENV]: systemSettingsPath };
}

/**
 * Run one SDK initialization while isolating process-wide Gemini/Google environment inputs.
 *
 * The Gemini CLI Core reads these variables during asynchronous initialization.
 * A process-wide queue prevents one connector from observing another connector's
 * temporary environment, and restoration preserves the caller's exact values.
 * @param selected - Explicit connector-owned SDK environment values to apply.
 * @param operation - SDK construction or initialization work.
 * @returns Operation result after exact environment restoration.
 */
export async function withGeminiSdkEnvironment<T>(
  selected: GeminiSdkEnvironmentSelection,
  operation: () => Promise<T> | T,
): Promise<T> {
  const run = environmentScopeTail.then(
    () => runWithGeminiSdkEnvironment(selected, operation),
    () => runWithGeminiSdkEnvironment(selected, operation),
  );
  environmentScopeTail = run.then(
    () => undefined,
    () => undefined,
  );
  return await run;
}

/**
 * Run an SDK operation while the connector-specific environment is installed.
 * @param selected - Explicit connector-owned SDK environment values to apply.
 * @param operation - SDK construction or initialization work.
 * @returns The operation result.
 */
async function runWithGeminiSdkEnvironment<T>(
  selected: GeminiSdkEnvironmentSelection,
  operation: () => Promise<T> | T,
): Promise<T> {
  const previous = new Map<GeminiSdkSensitiveEnvVar, string | undefined>(
    GEMINI_SDK_SENSITIVE_ENV_VARS.map((name) => [name, process.env[name]]),
  );
  try {
    for (const name of GEMINI_SDK_SENSITIVE_ENV_VARS) delete process.env[name];
    for (const name of GEMINI_SDK_SENSITIVE_ENV_VARS) {
      const value = selected[name];
      if (value !== undefined) process.env[name] = value;
    }
    return await operation();
  } finally {
    for (const name of GEMINI_SDK_SENSITIVE_ENV_VARS) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
