/**
 * Provider IDs and preset configuration for the Qwen ACP adapter.
 *
 * Provider compatibility is declared by stable definition ID — the adapter
 * subsystem resolves each ID to a full ProviderDefinitionInput from the
 * provider registry at boot time.
 */
export const providerIds = ['qwen-oauth'] as const;

/**
 * Default provider id to use when no provider is explicitly configured.
 */
export const defaultPresetId = 'qwen-oauth';

/** Provider id used for conformance tests (same as host default for this adapter). */
export const testPresetId: string = defaultPresetId;
