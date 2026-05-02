/**
 * Provider IDs and preset configuration for the OpenAI Node adapter.
 *
 * The OpenAI adapter supports any OpenAI-compatible API.
 * Provider compatibility is declared by stable definition ID — the adapter
 * subsystem resolves each ID to a full ProviderDefinitionInput from the
 * provider registry at boot time.
 *
 * Add new provider IDs here when introducing an OpenAI-compatible provider.
 */
export const providerIds = ['openai', 'nanogpt', 'openrouter', 'z-ai', 'alibaba', 'opencode-go'] as const;

/**
 * Default provider id to use when no provider is explicitly configured.
 *
 * Semantically `openai` — the native provider for this adapter.
 */
export const defaultPresetId = 'openai';

/**
 * Provider id used for conformance tests.
 *
 * Set to `opencode-go` (OpenCode Go gateway) to avoid expensive OpenAI API
 * calls during test runs while still exercising the OpenAI-compatible wire protocol.
 */
export const testPresetId = 'opencode-go';
