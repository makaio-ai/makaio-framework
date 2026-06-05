/**
 * Provider IDs and preset configuration for the Cursor SDK adapter.
 *
 * The Cursor SDK authenticates directly against Cursor's proprietary Composer API
 * using a cursor-specific credential type. Provider compatibility is declared by
 * stable definition ID; the adapter subsystem resolves each ID to a full provider
 * definition from active provider extensions at boot time.
 *
 * Supported providers:
 * - `cursor`: Cursor AI editor (CURSOR_API_KEY)
 */
export const providerIds = ['cursor'] as const;

/**
 * Default provider id to use when no provider is explicitly configured.
 *
 * Cursor is the only supported provider for this adapter.
 */
export const defaultPresetId = 'cursor';

/**
 * Provider id used for conformance tests.
 *
 * Set to `cursor` as this adapter only supports the Cursor provider.
 */
export const testPresetId = 'cursor';
