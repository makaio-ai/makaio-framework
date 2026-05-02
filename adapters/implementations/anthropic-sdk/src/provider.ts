/**
 * Provider IDs and preset configuration for the Anthropic SDK adapter.
 *
 * The Anthropic SDK adapter supports any Anthropic-compatible API.
 * Provider compatibility is declared by stable definition ID — the adapter
 * subsystem resolves each ID to a full ProviderDefinitionInput from the
 * provider registry at boot time.
 *
 * Add new provider IDs here when introducing an Anthropic-compatible provider.
 */
export const providerIds = ['z-ai', 'alibaba', 'opencode-go-anthropic', 'anthropic'] as const;

/**
 * Default provider id to use when no provider is explicitly configured.
 *
 * Semantically `anthropic` — the native provider for this adapter.
 */
export const defaultPresetId = 'anthropic';

/**
 * Provider id used for conformance tests.
 *
 * Set to `opencode-go-anthropic` so test runs exercise the Anthropic-compatible
 * OpenCode Go preset without hitting the direct Anthropic API.
 */
export const testPresetId = 'opencode-go-anthropic';
