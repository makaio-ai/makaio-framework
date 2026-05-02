/**
 * Provider IDs and preset configuration for the Claude Code CLI adapter.
 *
 * Provider compatibility is declared by stable definition ID — the adapter
 * subsystem resolves each ID to a full ProviderDefinitionInput from the
 * provider registry at boot time.
 */
export const providerIds = ['anthropic', 'anthropic-oauth', 'opencode-go-anthropic'] as const;

/**
 * Default provider id to use when no provider is explicitly configured.
 */
export const defaultPresetId = 'anthropic';

/** Provider id used for conformance tests through the Claude Code client auth context. */
export const testPresetId: (typeof providerIds)[number] = 'anthropic-oauth';
