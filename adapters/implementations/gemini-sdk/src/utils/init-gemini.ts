import { type Config, AuthType, GeminiChat, getCoreSystemPrompt } from '@google/gemini-cli-core';
import type { GeminiRegistryToolDeclaration } from '../tool-handling.js';

/**
 * Authentication options for the Gemini SDK.
 *
 * Gemini sessions always receive an explicit API-key delivery from the trusted
 * adapter-auth runtime. {@link initGemini} validates the key before passing it
 * to the Gemini SDK.
 */
export interface GeminiAuthOptions {
  /** Plaintext Gemini API key resolved from credential refs. */
  readonly apiKey: string;
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
 * @param authOptions - Explicit API-key authentication options delivered by Adapter Core.
 * @param registryToolDeclarations - Optional additional tool declarations from the central
 *   ToolRegistry. Merged after native declarations so registry tools appear last.
 * @returns The initialized GeminiChat and the base system instruction
 */
export async function initGemini(
  geminiConfig: GeminiInitConfig,
  disabledNativeTools: readonly string[],
  authOptions: GeminiAuthOptions,
  registryToolDeclarations?: readonly GeminiRegistryToolDeclaration[],
): Promise<GeminiInitResult> {
  const trimmedApiKey = authOptions.apiKey.trim();
  if (trimmedApiKey.length === 0) {
    throw new Error('Gemini API key was provided but is empty or whitespace-only.');
  }
  await geminiConfig.refreshAuth(AuthType.USE_GEMINI, trimmedApiKey);

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
