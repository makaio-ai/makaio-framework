/**
 * Shared constants for the CLI SDK example smoke fixture.
 *
 * These identifiers intentionally mirror the user-facing canonical model path
 * exercised by the Python SDK example.
 */
export const DEVEX_SMOKE_PROVIDER_ID = 'devex-smoke';
export const DEVEX_SMOKE_PROVIDER_NAME = 'DevEx Smoke Provider';
export const DEVEX_SMOKE_PROVIDER_PACKAGE = '@makaio/provider-devex-smoke';
export const DEVEX_SMOKE_ADAPTER_NAME = 'devex-smoke';
export const DEVEX_SMOKE_ADAPTER_PACKAGE = '@makaio/ai-adapters-devex-smoke';
export const DEVEX_SMOKE_MODEL = 'echo-model';
export const DEVEX_SMOKE_PROVIDER_CONFIG_ID = 'devex-smoke-default';
export const DEVEX_SMOKE_PROVIDER_CONFIG_NAME = 'DevEx Smoke Default';
export const DEVEX_SMOKE_CANONICAL_MODEL = `${DEVEX_SMOKE_ADAPTER_NAME}::${DEVEX_SMOKE_MODEL}`;
export const DEVEX_SMOKE_API_KEY_ENV = 'DEVEX_SMOKE_API_KEY';
