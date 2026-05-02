/**
 * Provider IDs and preset configuration for the GitHub Copilot SDK adapter.
 *
 * Provider compatibility is declared by stable definition ID — the adapter
 * subsystem resolves each ID to a full ProviderDefinitionInput from the
 * provider registry at boot time. Edit provider packages and registry YAML, not
 * generated artifacts.
 *
 * Note: GitHub Copilot SDK does not expose a models listing API,
 * so models are configured statically in the provider package.
 */
export const providerIds = ['github-copilot'] as const;

/**
 * Default provider id to use when no provider is explicitly configured.
 */
export const defaultPresetId = 'github-copilot';

/** Provider id used for conformance tests (same as host default for this adapter). */
export const testPresetId: string = defaultPresetId;
