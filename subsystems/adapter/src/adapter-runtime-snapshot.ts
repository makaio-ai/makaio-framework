import type { IMakaioBus } from '@makaio/bus-core';
import type {
  AdapterRuntimeSnapshotResolution,
  ProviderRuntimeSnapshot,
} from '@makaio/services-core/adapter-subsystem';
import { ExtensionSubjects } from '@makaio/kernel';
import type { AdapterProviderAuth, AuthMethodRef } from '@makaio/contracts/auth';
import type { LoadedAdapter } from './adapter-runtime-types.js';
import { resolveDefaultClientId } from './adapter-client-refs.js';

/** Input captured by the adapter-subsystem atomic runtime read. */
export interface ResolveAdapterRuntimeSnapshotInput {
  /** Bus used only for contribution and installed-package metadata reads. */
  readonly bus: IMakaioBus;
  /** Loaded adapter captured for this request, when present. */
  readonly adapter: LoadedAdapter | undefined;
  /** Provider snapshot captured from the canonical config store. */
  readonly snapshot: ProviderRuntimeSnapshot | null;
  /** Binding authorization captured with the provider snapshot. */
  readonly isBound: boolean;
}

interface ProviderJunction {
  readonly ref: LoadedAdapter['providerRefs'][number];
  readonly provider: LoadedAdapter['providers'][number];
}

/**
 * Resolve one unambiguous adapter/provider junction.
 * @param adapter - Loaded adapter metadata.
 * @param definitionId - Selected provider definition.
 * @returns Exact junction, or null when declarations are missing or ambiguous.
 */
function resolveProviderJunction(adapter: LoadedAdapter, definitionId: string): ProviderJunction | null {
  const refs = adapter.providerRefs.filter((ref) => ref.definitionId === definitionId);
  const providers = adapter.providers.filter((entry) => entry.definition.id === definitionId);
  const ref = refs[0];
  const provider = providers[0];
  return refs.length === 1 && providers.length === 1 && ref !== undefined && provider !== undefined
    ? { ref, provider }
    : null;
}

/**
 * Check client compatibility declared by the loaded adapter.
 * @param adapter - Loaded adapter metadata.
 * @param clientId - Selected client, when the path uses one.
 * @returns Whether the adapter accepts the selected client.
 */
function supportsClient(adapter: LoadedAdapter, clientId: string | undefined): boolean {
  return clientId === undefined || adapter.clients?.some((clientRef) => clientRef.id === clientId) === true;
}

/**
 * Check whether an adapter auth declaration delivers one selected method.
 * @param auth - Junction auth declaration, when present.
 * @param method - Selected owner-qualified method.
 * @returns Whether the declaration contains the exact method binding.
 */
function deliversMethod(auth: AdapterProviderAuth | undefined, method: AuthMethodRef): auth is AdapterProviderAuth {
  return auth?.bindings.some((binding) => methodRefsEqual(binding.method, method)) === true;
}

/**
 * Check package metadata required to reconstruct the runtime locally.
 * @param adapterPackageName - Adapter extension package name.
 * @param providerPackageName - Provider extension package name.
 * @param clientId - Selected client, when present.
 * @param clientPackageName - Resolved client extension package name.
 * @returns Whether every selected runtime package has a non-empty identity.
 */
function hasRuntimePackageMetadata(
  adapterPackageName: string,
  providerPackageName: string,
  clientId: string | undefined,
  clientPackageName: string | undefined,
): boolean {
  return (
    adapterPackageName.trim().length > 0 &&
    providerPackageName.trim().length > 0 &&
    (clientId === undefined || (clientPackageName?.trim().length ?? 0) > 0)
  );
}

/**
 * Combine one provider snapshot with exact loaded-adapter runtime metadata.
 *
 * The result remains refs-only. It deliberately returns adapter auth
 * declarations rather than importing Adapter Core to bind them, preserving the
 * subsystem → services dependency direction.
 * @param input - Captured provider, adapter, and metadata bus inputs
 * @returns Typed success or credential-free failure
 */
export async function resolveAdapterRuntimeSnapshot(
  input: ResolveAdapterRuntimeSnapshotInput,
): Promise<AdapterRuntimeSnapshotResolution> {
  if (input.snapshot === null) {
    return { status: 'error', code: 'provider-config-not-found' };
  }
  if (input.adapter === undefined) {
    return { status: 'error', code: 'adapter-not-loaded' };
  }
  if (!input.isBound) {
    return { status: 'error', code: 'adapter-not-bound' };
  }

  const definitionId = input.snapshot.context.definitionId;
  const junction = resolveProviderJunction(input.adapter, definitionId);
  if (junction === null) {
    return { status: 'error', code: 'provider-incompatible' };
  }
  const { provider } = junction;
  const adapterProviderAuth = provider.auth;
  const selectedMethod = input.snapshot.context.auth.method;
  if (!deliversMethod(adapterProviderAuth, selectedMethod)) {
    return { status: 'error', code: 'auth-binding-missing' };
  }

  const adapterClientId =
    selectedMethod.owner === 'client'
      ? selectedMethod.clientId
      : resolveDefaultClientId(input.adapter.options, input.adapter.clients);
  if (!supportsClient(input.adapter, adapterClientId)) {
    return { status: 'error', code: 'client-incompatible' };
  }

  const catalog = await input.bus.request(ExtensionSubjects.contributions.catalog, {});
  const clientCatalogEntries =
    adapterClientId === undefined ? [] : catalog.clients.filter((entry) => entry.definition.id === adapterClientId);
  if (adapterClientId !== undefined && clientCatalogEntries.length !== 1) {
    return { status: 'error', code: 'client-incompatible' };
  }
  const clientPackageName = clientCatalogEntries[0]?.packageName;

  if (
    !hasRuntimePackageMetadata(
      input.adapter.packageName,
      provider.providerPackageName,
      adapterClientId,
      clientPackageName,
    )
  ) {
    return { status: 'error', code: 'runtime-package-metadata-missing' };
  }

  const compatibleProviderAuths = input.adapter.providers.flatMap((candidate) =>
    candidate.definition.id !== definitionId && candidate.auth !== undefined ? [candidate.auth] : [],
  );
  const clientPackage =
    adapterClientId !== undefined && clientPackageName !== undefined
      ? { packageName: clientPackageName, clientId: adapterClientId }
      : undefined;
  return {
    status: 'resolved',
    runtime: {
      snapshot: input.snapshot,
      adapterName: input.adapter.name,
      ...(adapterClientId !== undefined && { adapterClientId }),
      ...(provider.protocol !== undefined && { providerProtocol: provider.protocol }),
      adapterProviderAuth,
      compatibleProviderAuths,
      runtimePackages: {
        adapter: { packageName: input.adapter.packageName },
        provider: { packageName: provider.providerPackageName, definitionId },
        ...(clientPackage !== undefined && { client: clientPackage }),
      },
    },
  };
}

/**
 * Compare owner-qualified auth method references without importing Adapter Core.
 * @param left - First method reference.
 * @param right - Second method reference.
 * @returns Whether both references identify the same declared method.
 */
function methodRefsEqual(left: AuthMethodRef, right: AuthMethodRef): boolean {
  if (left.owner !== right.owner || left.methodId !== right.methodId) {
    return false;
  }
  return left.owner === 'provider'
    ? right.owner === 'provider' && left.providerDefinitionId === right.providerDefinitionId
    : right.owner === 'client' && left.clientId === right.clientId;
}
