import type { AdapterProviderDefinitionContract } from '@makaio/contracts';

/**
 * Runtime adapter provider definition pairing a serializable provider definition
 * with optional runtime-only provider configuration metadata.
 *
 * Aliases {@link AdapterProviderDefinitionContract} from `@makaio/contracts`,
 * the single source of truth for the `definition` and `configSchema` fields.
 * The domain-specific name keeps adapter implementation signatures readable
 * without creating a second provider-definition contract.
 *
 * Each adapter exports an array of these from its `definition.ts` (via `providers`).
 * The `definition` field contains serializable data (models, endpoints, etc.).
 * Config schemas are runtime-only — used for UI form generation, never serialized.
 */
export type AdapterProviderDefinition = AdapterProviderDefinitionContract;
