import { type Config, AuthType, GeminiChat, getCoreSystemPrompt } from '@google/gemini-cli-core';
import type { GeminiRegistryToolDeclaration } from '../tool-handling.js';

/**
 * Authentication options for the Gemini SDK.
 *
 * Presence of this object signals explicit API-key auth intent. {@link initGemini}
 * validates the `apiKey` value and throws if it is blank or whitespace-only.
 * OAuth login (`AuthType.LOGIN_WITH_GOOGLE`) is used only when `authOptions`
 * is omitted entirely (`undefined`), not when `apiKey` is absent within the object.
 */
export interface GeminiAuthOptions {
  /** Plaintext Gemini API key resolved from credential refs. */
  apiKey?: string;
}

/**
 * Build Gemini auth options from resolved connector credentials.
 *
 * Explicit credential presence means "attempt API-key auth", even when the
 * value is blank. `initGemini()` owns validation of blank values so the
 * connector never silently falls back to OAuth when a configured credential is
 * present but malformed.
 * @param credentials - Resolved connector credentials keyed by field name
 * @returns Explicit auth options when `apiKey` was resolved, otherwise `undefined`
 */
export function buildGeminiAuthOptions(credentials: Record<string, string>): GeminiAuthOptions | undefined {
  return Object.hasOwn(credentials, 'apiKey') ? { apiKey: credentials['apiKey'] } : undefined;
}

/** Result of initGemini, exposing the system instruction for runtime overrides. */
export interface GeminiInitResult {
  /** The initialized GeminiChat instance */
  geminiChat: GeminiChat;
  /** The SDK's base system instruction */
  baseSystemInstruction: string;
}

/**
 * Minimal config contract required by initGemini.
 */
type GeminiConfigRequired = Pick<Config, 'refreshAuth' | 'initialize' | 'getUserMemory'>;
type GeminiConfigPassthrough = Omit<Partial<Config>, keyof GeminiConfigRequired | 'getToolRegistry'>;

export type GeminiInitConfig = GeminiConfigPassthrough &
  GeminiConfigRequired & {
    /** Returns the SDK tool registry used to produce function declarations. */
    getToolRegistry: () => { getFunctionDeclarations: () => Array<{ name?: string }> };
  };

/** Tool declaration shape accepted by GeminiChat. */
export interface GeminiToolDeclaration {
  name: string;
}

/**
 * Filter function declarations to only named declarations that are not disabled.
 * @param declarations - Declarations from the SDK tool registry.
 * @param disabledNativeTools - Tool names disabled by the active harness.
 * @returns Declarations safe to pass to GeminiChat.
 */
export function filterToolDeclarations(
  declarations: readonly { name?: string }[],
  disabledNativeTools: readonly string[],
): GeminiToolDeclaration[] {
  const disabledSet = new Set(disabledNativeTools);
  return declarations.filter(
    (tool): tool is GeminiToolDeclaration => typeof tool.name === 'string' && !disabledSet.has(tool.name),
  );
}

/**
 * Initializes the Gemini chat instance with authentication and
 * configuration.
 * @param geminiConfig - The Gemini configuration object
 * @param disabledNativeTools - SDK-native tool names to exclude from the tool registry.
 *   Sourced from the active harness's `nativeTools.disabled` list.
 * @param registryToolDeclarations - Optional additional tool declarations from the central
 *   ToolRegistry. Merged after native declarations so registry tools appear last.
 * @param authOptions - Optional authentication options. When `apiKey` is provided,
 *   authenticates with `AuthType.USE_GEMINI`. An explicitly provided missing, non-string,
 *   empty, or whitespace-only `apiKey` fails fast. OAuth fallback is used only when
 *   `authOptions` is omitted entirely.
 * @returns The initialized GeminiChat and the base system instruction
 */
export async function initGemini(
  geminiConfig: GeminiInitConfig,
  disabledNativeTools: readonly string[],
  registryToolDeclarations?: readonly GeminiRegistryToolDeclaration[],
  authOptions?: GeminiAuthOptions,
): Promise<GeminiInitResult> {
  // Initialize auth first (creates ContentGenerator).
  // Explicit auth options mean "use API-key auth"; OAuth fallback is reserved
  // for the implicit path where no auth options were provided at all.
  const apiKey = authOptions?.apiKey;
  if (typeof apiKey === 'string') {
    const trimmedApiKey = apiKey.trim();
    if (trimmedApiKey.length === 0) {
      throw new Error('Gemini API key was provided but is empty or whitespace-only.');
    }
    await geminiConfig.refreshAuth(AuthType.USE_GEMINI, trimmedApiKey);
  } else if (authOptions !== undefined) {
    throw new Error('Gemini authOptions were provided without a valid API key.');
  } else {
    await geminiConfig.refreshAuth(AuthType.LOGIN_WITH_GOOGLE);
  }

  // Then initialize config (creates GeminiClient, ToolRegistry, MessageBus, etc.)
  await geminiConfig.initialize();

  // Get tools from registry, filtering out SDK-native tools disabled by the harness.
  // The disabled list is sourced from HarnessSubjects.getDefault at connector init time.
  const toolRegistry = geminiConfig.getToolRegistry();
  const nativeDeclarations = filterToolDeclarations(toolRegistry.getFunctionDeclarations(), disabledNativeTools);

  // Merge registry tools after native declarations (registry tools are not in the SDK's
  // internal ToolRegistry — execution falls back to the bus path in executeToolCalls).
  // Registry tools whose names collide with a native SDK tool are skipped to avoid
  // shadowing harness-filtered tools or causing duplicate declaration conflicts.
  const nativeToolNames = new Set(nativeDeclarations.map((t) => t.name));
  const filteredRegistryDeclarations = registryToolDeclarations?.filter((t) => {
    if (nativeToolNames.has(t.name)) {
      console.warn(`[GeminiAgent] Registry tool '${t.name}' collides with an SDK-native tool and will be skipped.`);
      return false;
    }
    return true;
  });

  const toolDeclarations: Array<GeminiToolDeclaration | GeminiRegistryToolDeclaration> =
    filteredRegistryDeclarations && filteredRegistryDeclarations.length > 0
      ? [...nativeDeclarations, ...filteredRegistryDeclarations]
      : nativeDeclarations;

  const tools = [{ functionDeclarations: toolDeclarations }];

  // Get system prompt from SDK
  const userMemory = geminiConfig.getUserMemory();
  const baseSystemInstruction = getCoreSystemPrompt(geminiConfig as Config, userMemory);

  // Create GeminiChat with tools
  // Note: thinkingBudget is configured via modelConfigServiceConfig in createGeminiConfig
  const geminiChat = new GeminiChat(geminiConfig as Config, baseSystemInstruction, tools);
  return { geminiChat, baseSystemInstruction };
}
