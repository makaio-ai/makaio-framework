/**
 * Building the Pi model registry, and reading a model back out of it.
 *
 * Kept beside the connector rather than inside it because neither act needs the
 * connector: both are functions of the resolved provider identity and a model id,
 * and both are performed twice — once when the session is created and once when the
 * model is switched in place. One implementation for both is what keeps a switched
 * model registered exactly the way the initial one was.
 * @packageDocumentation
 */
import { AuthStorage, ModelRegistry } from '@mariozechner/pi-coding-agent';
import type { Model } from '@mariozechner/pi-ai';
import type { ProtocolId, ResolvedProviderContext } from '@makaio/contracts';
import { registerMakaioProviderModel } from './provider-registry.js';

/** The resolved provider identity a Pi model registry is built for. */
export interface PiRegistryIdentity {
  /** Exact resolved provider identity used for registry and endpoint selection. */
  readonly providerContext: ResolvedProviderContext;
  /** Exact protocol declared by the selected adapter/provider reference. */
  readonly protocol: ProtocolId;
  /** Connector-local provider key reused across registry rebuilds. */
  readonly apiKey: string;
}

/** A built Pi model registry, with what it was built from. */
export interface PiModelRegistry {
  /** Auth storage the registry resolves credentials through. */
  readonly authStorage: AuthStorage;
  /** The registry itself, with the Makaio provider registered. */
  readonly modelRegistry: ModelRegistry;
  /** Provider name the requested model was registered under. */
  readonly providerName: string;
}

/**
 * Build an `AuthStorage`-backed `ModelRegistry` for one model.
 *
 * Registers the Makaio provider so `getAvailable()` includes the requested model.
 * @param identity - Resolved provider identity to register the model under
 * @param modelId - The model ID to register in the registry
 * @returns Ready-to-use auth storage, registry, and the provider name used
 */
export function buildPiModelRegistry(identity: PiRegistryIdentity, modelId: string): PiModelRegistry {
  const authStorage = AuthStorage.create();
  const providerName = identity.providerContext.definitionId;
  authStorage.setRuntimeApiKey(providerName, identity.apiKey);

  const modelRegistry = ModelRegistry.create(authStorage);
  registerMakaioProviderModel(
    modelRegistry,
    providerName,
    modelId,
    identity.protocol,
    identity.providerContext.endpointOverrides,
    identity.apiKey,
  );

  return { authStorage, modelRegistry, providerName };
}

/**
 * Resolve the Pi SDK model object a registry was built for.
 *
 * Returns `undefined` rather than throwing when no entry matches: session creation
 * falls back to the Pi SDK default, and an in-place switch refuses — two different
 * answers to one lookup, which is why the lookup itself only reports.
 * @param registry - Registry built by {@link buildPiModelRegistry}
 * @param modelId - The model ID to look up
 * @returns The resolved Pi model, or `undefined` when the registry has no match
 */
export async function resolvePiModel(registry: PiModelRegistry, modelId: string): Promise<Model<never> | undefined> {
  const available = await registry.modelRegistry.getAvailable();
  const found = available.find((model) => model.id === modelId && model.provider === registry.providerName);
  if (!found) {
    console.warn(`[PiConnector] Model '${registry.providerName}/${modelId}' not found in registry`);
  }
  return found as Model<never> | undefined;
}
