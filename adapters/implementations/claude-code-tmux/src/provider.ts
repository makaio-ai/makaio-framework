/**
 * Provider IDs and preset configuration for the Claude Code tmux adapter.
 *
 * Same providers as the CLI adapter — both use Claude Code which authenticates
 * via the Anthropic API. The tmux adapter just runs interactively instead of
 * via stdio JSON streaming.
 */
export const providerIds = ['anthropic', 'anthropic-oauth'] as const;

/** Default provider when no explicit provider is configured. */
export const defaultPresetId = 'anthropic';

/** Provider used for conformance tests through the Claude Code client auth context. */
export const testPresetId: (typeof providerIds)[number] = 'anthropic-oauth';
