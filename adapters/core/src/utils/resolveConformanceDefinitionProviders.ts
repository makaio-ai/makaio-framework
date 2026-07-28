import type { AdapterProviderRef, ProviderDefinitionInput } from '@makaio/contracts';
import type { AdapterProviderDefinition } from '../types/index.js';

/**
 * Inputs for pairing conformance provider definitions with adapter declarations.
 */
export interface ResolveConformanceDefinitionProvidersOptions {
  /** Adapter name used in configuration error messages. */
  readonly adapterName: string;
  /** Accepted provider definitions from the resolved conformance preset. */
  readonly providers: readonly ProviderDefinitionInput[];
  /** Provider declarations exported by the adapter definition. */
  readonly adapterProviders: readonly AdapterProviderRef[];
}

/**
 * Pair conformance provider definitions with the adapter's own provider
 * declarations for injection as `definitionProviders`.
 *
 * An adapter under test is constructed directly rather than booted, so nothing
 * resolves its declared provider IDs into full definitions the way the adapter
 * subsystem does at startup. Without this pairing the adapter runs with an
 * empty provider list: authentication delivery is looked up by provider
 * definition ID, finds nothing, and a resolved provider context fails as though
 * the adapter had never declared authentication at all.
 *
 * Connector-level tests do not hit this because they resolve delivery straight
 * from the adapter declarations, which is why the gap only surfaces once a test
 * starts an agent through the adapter.
 * @param options - Adapter name, preset providers, and adapter declarations.
 * @returns Runtime provider definitions in preset order.
 * @throws When a preset provider is not declared by the adapter.
 */
export function resolveConformanceDefinitionProviders(
  options: ResolveConformanceDefinitionProvidersOptions,
): AdapterProviderDefinition[] {
  const { adapterName, providers, adapterProviders } = options;

  // A paired entry carries `definition`, `protocol` and `auth` only.
  //
  // `configSchema` is left off. Its only reader is the `definition.getConfigSchema`
  // handler, which renders provider settings forms from the booted adapter
  // registry — a surface no conformance test reaches. Boot also falls back to the
  // adapter-level provider config schema when a declaration omits its own, and
  // that default is not an input here, so carrying just the per-provider override
  // would report a schema disagreeing with the booted one rather than none at all.
  //
  // `auth` is carried verbatim, which is narrower than boot: the adapter subsystem
  // resolves each declaration against the authoritative method definitions and
  // widens `scrubEnvVars` with the source-hint variables of the provider and of
  // every client the adapter may execute. Conformance therefore scrubs only the
  // variables an adapter lists explicitly, so an ambient credential that the
  // booted path strips can still reach the agent under test.
  // TODO: share the subsystem's provider-auth resolver from a boundary this
  // package can reach, then pass the adapter's client definitions through here so
  // conformance validates bindings and scrubs exactly what the booted path does.
  return providers.map((definition) => {
    const declared = adapterProviders.find((provider) => provider.definitionId === definition.id);
    if (!declared) {
      const available = adapterProviders.map((provider) => provider.definitionId).join(', ');
      throw new Error(
        `[${adapterName}] Conformance provider '${definition.id}' is not declared by the adapter. ` +
          `Declared providers: ${available || 'none'}.`,
      );
    }
    return {
      definition,
      ...(declared.protocol !== undefined && { protocol: declared.protocol }),
      ...(declared.auth !== undefined && { auth: declared.auth }),
    };
  });
}
