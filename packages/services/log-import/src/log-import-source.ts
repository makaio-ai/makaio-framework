import type { LogImporterSource } from './types.js';

/**
 * Classify a log importer registration for UI and provenance surfaces.
 *
 * Adapter capability providers and extension packages that declare adapter
 * contributions are adapter-backed importers. Extension packages without
 * adapter contributions remain extension-backed, even when their stable
 * `adapterName` uses a legacy namespace such as `plugin:opencode`.
 * @param options - Registration path metadata.
 * @returns Public log importer source classification.
 */
export function classifyLogImporterSource(options: { readonly hasAdapterContribution: boolean }): LogImporterSource {
  return options.hasAdapterContribution ? 'adapter' : 'extension';
}
