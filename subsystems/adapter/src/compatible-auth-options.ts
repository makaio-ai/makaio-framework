import { isDeepStrictEqual } from 'node:util';
import type { IMakaioBus } from '@makaio/bus-core';
import {
  assertAdapterAuthBindingMatchesMethod,
  type AuthMethodRef,
  type ClientAuthMethodDefinition,
  type ProviderAuthMethodDefinition,
} from '@makaio/contracts/auth';
import type { CompatibleAuthOption } from '@makaio/services-core/adapter-subsystem';
import { ClientStorageSubjects, type ClientRecord } from '@makaio/services-core/settings/storage';
import type { LoadedAdapter, LoadedAdapterProvider } from './adapter-runtime-types.js';

type CompatibleAuthOptionCore = CompatibleAuthOption extends infer Option
  ? Option extends CompatibleAuthOption
    ? Omit<Option, 'compatibleAdapterNames'>
    : never
  : never;

interface AggregatedCompatibleAuthOption {
  readonly option: CompatibleAuthOptionCore;
  readonly adapterNames: Set<string>;
}

/**
 * Build UI-safe authentication choices from loaded adapter bindings plus the
 * referenced provider/client method definitions.
 * @param bus - Bus used to resolve client-owned method definitions.
 * @param adapters - Current loaded-adapter snapshot.
 * @param definitionId - Provider definition whose compatible methods are requested.
 * @returns Deduplicated options with deterministic adapter ordering.
 */
export async function buildCompatibleAuthOptions(
  bus: IMakaioBus,
  adapters: readonly LoadedAdapter[],
  definitionId: string,
): Promise<CompatibleAuthOption[]> {
  const aggregated = new Map<string, AggregatedCompatibleAuthOption>();
  const clients = new Map<string, Promise<ClientRecord>>();

  for (const adapter of [...adapters].sort((left, right) => left.name.localeCompare(right.name))) {
    for (const provider of adapter.providers.filter(({ definition }) => definition.id === definitionId)) {
      for (const binding of provider.auth?.bindings ?? []) {
        const method = await resolveBoundMethod(bus, adapter, provider, binding.method, clients);
        assertAdapterAuthBindingMatchesMethod(binding, method);
        const key = methodRefKey(definitionId, binding.method);
        const option = toCompatibleAuthOption(definitionId, binding.method, method);
        const existing = aggregated.get(key);
        if (existing) {
          if (!compatibleAuthOptionsEqual(existing.option, option)) {
            throw new Error(
              `Authentication method ${key} has conflicting definitions across compatible adapters ` +
                `"${[...existing.adapterNames].join(', ')}" and "${adapter.name}".`,
            );
          }
          existing.adapterNames.add(adapter.name);
          continue;
        }

        aggregated.set(key, {
          option,
          adapterNames: new Set([adapter.name]),
        });
      }
    }
  }

  return [...aggregated.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, { option, adapterNames }]) =>
      withCompatibleAdapterNames(
        option,
        [...adapterNames].sort((left, right) => left.localeCompare(right)),
      ),
    );
}

/**
 * Compare the complete UI-visible declaration for one owner-qualified method.
 * @param left - Previously aggregated method declaration.
 * @param right - Method declaration contributed by another adapter.
 * @returns Whether both adapters expose the same authoritative method contract.
 */
function compatibleAuthOptionsEqual(left: CompatibleAuthOptionCore, right: CompatibleAuthOptionCore): boolean {
  return isDeepStrictEqual(left, right);
}

/**
 * Resolve one binding to its authoritative static method definition.
 * @param bus - Bus used for client storage reads.
 * @param adapter - Adapter that declared the binding.
 * @param provider - Provider path that owns the binding.
 * @param methodRef - Provider/client method reference from the binding.
 * @param clients - Per-call client lookup cache.
 * @returns Matching provider/client method definition.
 */
async function resolveBoundMethod(
  bus: IMakaioBus,
  adapter: LoadedAdapter,
  provider: LoadedAdapterProvider,
  methodRef: AuthMethodRef,
  clients: Map<string, Promise<ClientRecord>>,
): Promise<ProviderAuthMethodDefinition | ClientAuthMethodDefinition> {
  if (methodRef.owner === 'provider') {
    if (methodRef.providerDefinitionId !== provider.definition.id) {
      throw new Error(
        `Adapter "${adapter.name}" binds provider method "${methodRef.methodId}" to the wrong definition ` +
          `("${methodRef.providerDefinitionId}" instead of "${provider.definition.id}").`,
      );
    }
    const method = (provider.definition.authMethods ?? []).find(({ id }) => id === methodRef.methodId);
    if (!method) {
      throw new Error(
        `Adapter "${adapter.name}" binds undeclared provider auth method ` +
          `"${provider.definition.id}/${methodRef.methodId}".`,
      );
    }
    return method;
  }

  if (!(adapter.clients ?? []).some(({ id }) => id === methodRef.clientId)) {
    throw new Error(
      `Adapter "${adapter.name}" binds auth method "${methodRef.clientId}/${methodRef.methodId}" ` +
        'without declaring that client.',
    );
  }

  let clientPromise = clients.get(methodRef.clientId);
  if (!clientPromise) {
    clientPromise = loadClient(bus, methodRef.clientId);
    clients.set(methodRef.clientId, clientPromise);
  }
  const client = await clientPromise;
  const method = client.authMethods.find(({ id }) => id === methodRef.methodId);
  if (!method) {
    throw new Error(
      `Adapter "${adapter.name}" binds undeclared client auth method ` +
        `"${methodRef.clientId}/${methodRef.methodId}".`,
    );
  }
  return method;
}

/**
 * Load one client record or fail with a binding diagnostic.
 * @param bus - Bus used for the storage request.
 * @param clientId - Referenced client identifier.
 * @returns Existing client record.
 */
async function loadClient(bus: IMakaioBus, clientId: string): Promise<ClientRecord> {
  const { client } = await bus.request(ClientStorageSubjects.get, { id: clientId });
  if (!client) {
    throw new Error(`Authentication binding references missing client definition "${clientId}".`);
  }
  return client;
}

/**
 * Convert one authoritative method declaration into a safe UI option.
 * @param definitionId - Provider definition served by the binding.
 * @param methodRef - Full provider/client method reference.
 * @param method - Resolved method declaration.
 * @returns Option without its aggregated adapter-name list.
 */
function toCompatibleAuthOption(
  definitionId: string,
  methodRef: AuthMethodRef,
  method: ProviderAuthMethodDefinition | ClientAuthMethodDefinition,
): CompatibleAuthOptionCore {
  const common = {
    definitionId,
    method: { ...methodRef },
    label: method.label,
    ...(method.description ? { description: method.description } : {}),
  };

  switch (method.mode) {
    case 'explicit':
      return {
        ...common,
        mode: 'explicit',
        fields: method.fields.map((field) => ({
          ...field,
          sourceHints: field.sourceHints.map((hint) => ({ ...hint })),
        })),
        portability: 'portable',
      };
    case 'inferred':
      if (methodRef.owner !== 'client') {
        throw new Error(`Inferred auth method "${method.id}" must be client-owned.`);
      }
      return {
        ...common,
        method: { ...methodRef },
        mode: 'inferred',
        fields: [],
        portability: 'local-only',
      };
    case 'none':
      return {
        ...common,
        mode: 'none',
        fields: [],
        portability: 'portable',
      };
  }
}

/**
 * Attach the aggregated adapter-name list while preserving the option's
 * discriminated mode.
 * @param option - Option derived from one method declaration.
 * @param compatibleAdapterNames - Sorted adapters that can deliver the method.
 * @returns Complete compatible-auth option.
 */
function withCompatibleAdapterNames(
  option: CompatibleAuthOptionCore,
  compatibleAdapterNames: string[],
): CompatibleAuthOption {
  switch (option.mode) {
    case 'explicit':
      return { ...option, compatibleAdapterNames };
    case 'inferred':
      return { ...option, compatibleAdapterNames };
    case 'none':
      return { ...option, compatibleAdapterNames };
  }
}

/**
 * Build a collision-free grouping key for one provider-path method.
 * @param definitionId - Provider path receiving the method.
 * @param method - Full provider/client method reference.
 * @returns Stable serialized key.
 */
function methodRefKey(definitionId: string, method: AuthMethodRef): string {
  return JSON.stringify(
    method.owner === 'provider'
      ? [definitionId, method.owner, method.providerDefinitionId, method.methodId]
      : [definitionId, method.owner, method.clientId, method.methodId],
  );
}
