import type { IMakaioBus } from '@makaio/bus-core';
import type { AIModel, EntityUIConfig } from '@makaio/contracts';
import type { LoadedAdapter, AdapterInstance } from '@makaio/subsystem-adapter';
import type { BindingRecord } from '@makaio/services-core/adapter-subsystem';
import { resolveConnectorCredentials } from '@makaio/ai-adapters-core/config';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { DefinitionSubjects } from '@makaio/services-core/definition';
import { buildProviderContext } from '@makaio/services-core/provider-context';
import { ProviderRuntimeSubjects } from '@makaio/services-core/provider-runtime';
import { SettingsSubjects } from '@makaio/services-core/settings/namespace';
import { z } from 'zod';

type LoadedProviderDefinition = LoadedAdapter['providers'][number];
type AdapterWithFetchModels = AdapterInstance & {
  fetchModels: (baseUrl: string | undefined, credentials: Record<string, string> | undefined) => Promise<AIModel[]>;
};

/**
 * Run registered runtime handler cleanups in reverse order.
 * @param cleanups - Mutable cleanup stack captured during registration.
 */
export function runRuntimeHandlerCleanups(cleanups: Array<() => void>): void {
  let firstError: unknown;
  let hasFirstError = false;
  for (let index = cleanups.length - 1; index >= 0; index -= 1) {
    const cleanup = cleanups[index];
    try {
      cleanup();
    } catch (error) {
      if (!hasFirstError) {
        firstError = error;
        hasFirstError = true;
      }
    }
  }
  cleanups.length = 0;
  if (hasFirstError) {
    throw firstError;
  }
}

/**
 * Run runtime handler registration and roll back partial registrations on failure.
 * @param cleanups - Mutable cleanup stack captured during registration.
 * @param register - Registration operation to run.
 * @returns Registration result.
 */
function registerWithCleanupRollback<T>(cleanups: Array<() => void>, register: () => T): T {
  try {
    return register();
  } catch (error) {
    try {
      runRuntimeHandlerCleanups(cleanups);
    } catch {
      // Preserve the original registration failure; cleanup errors during rollback
      // are secondary and teardown still clears the cleanup stack.
    }
    throw error;
  }
}

/**
 * Find the provider definition exposed by any loaded adapter.
 * @param loadedAdapters - Runtime-loaded adapter definitions.
 * @param definitionId - Provider definition id to locate.
 * @returns Matching provider definition, or `undefined` when no adapter owns it.
 */
function findProviderDefinition(
  loadedAdapters: readonly LoadedAdapter[],
  definitionId: string,
): LoadedProviderDefinition | undefined {
  for (const adapter of loadedAdapters) {
    const provider = adapter.providers.find((candidate) => candidate.definition.id === definitionId);
    if (provider) {
      return provider;
    }
  }
  return undefined;
}

/**
 * Resolve the loaded adapter bound to a provider config.
 * @param loadedAdapters - Runtime-loaded adapter definitions.
 * @param bindings - Adapter-subsystem bindings for the provider config.
 * @param definitionId - Provider definition required by the provider config.
 * @returns Matching loaded adapter, or `undefined` when no binding maps to a loaded adapter.
 */
function findBoundAdapter(
  loadedAdapters: readonly LoadedAdapter[],
  bindings: readonly BindingRecord[],
  definitionId: string,
): LoadedAdapter | undefined {
  for (const binding of bindings) {
    const adapter = loadedAdapters.find((candidate) => candidate.name === binding.adapterName);
    if (adapter?.providers.some((provider) => provider.definition.id === definitionId)) {
      return adapter;
    }
  }
  return undefined;
}

/**
 * Remove the JSON Schema dialect metadata before returning schemas to clients.
 * @param jsonSchema - Schema object produced by Zod's JSON Schema converter.
 * @returns Schema payload without top-level `$schema` metadata.
 */
function stripMetaSchema(jsonSchema: unknown): Record<string, unknown> {
  const { $schema: _, ...schema } = jsonSchema as Record<string, unknown>;
  return schema;
}

// NOTE: do NOT change without explicit human approval
/* eslint max-lines-per-function: ["error", { "max": 160 }] */
/**
 * Register runtime bus handlers for adapter listing, config schemas, and model fetching.
 *
 * Handlers read adapter state lazily at request time so adapter changes made
 * during coordinator activation remain visible without re-registration.
 * @param bus - Runtime bus.
 * @param getLoadedAdapters - Getter for current loaded adapter definitions.
 * @param getAdapterInstances - Getter for current adapter instances.
 * @param getExtension - Coordinator lookup for extension config schemas.
 * @returns Cleanup function that unregisters all runtime handlers.
 */
export function registerRuntimeHandlers(
  bus: IMakaioBus,
  getLoadedAdapters: () => readonly LoadedAdapter[],
  getAdapterInstances: () => ReadonlyMap<string, AdapterInstance>,
  getExtension?: (name: string) => { configSchema?: z.ZodType; uiConfig?: EntityUIConfig } | undefined,
): () => void {
  const cleanups: Array<() => void> = [];

  return registerWithCleanupRollback(cleanups, () => {
    cleanups.push(
      bus.on(SettingsSubjects.adapter.getConfigSchema, ({ payload, setResult }) => {
        const adapter = getLoadedAdapters().find((a) => a.name === payload.adapterName);

        if (!adapter?.adapterConfigSchema) {
          setResult({ hasSchema: false, schema: null });
          return;
        }

        const jsonSchema = z.toJSONSchema(adapter.adapterConfigSchema);
        setResult({ hasSchema: true, schema: jsonSchema });
      }),
    );

    cleanups.push(
      bus.on(DefinitionSubjects.getCredentialSchema, ({ payload, setResult }) => {
        const credentialSchema = findProviderDefinition(getLoadedAdapters(), payload.definitionId)?.credentialSchema;
        if (credentialSchema) {
          setResult({ hasSchema: true, schema: z.toJSONSchema(credentialSchema) });
          return;
        }
        setResult({ hasSchema: false, schema: null });
      }),
    );

    cleanups.push(
      bus.on(DefinitionSubjects.getConfigSchema, ({ payload, setResult }) => {
        const configSchema = findProviderDefinition(getLoadedAdapters(), payload.definitionId)?.configSchema;
        if (configSchema) {
          setResult({ hasSchema: true, schema: z.toJSONSchema(configSchema) });
          return;
        }
        setResult({ hasSchema: false, schema: null });
      }),
    );

    if (getExtension) {
      cleanups.push(
        bus.on(SettingsSubjects.extension.getConfigSchema, ({ payload, setResult }) => {
          const pkg = getExtension(payload.extensionName);

          if (!pkg?.configSchema) {
            setResult({ hasSchema: false, schema: null, uiConfig: null });
            return;
          }

          const schema = stripMetaSchema(z.toJSONSchema(pkg.configSchema));
          setResult({ hasSchema: true, schema, uiConfig: pkg.uiConfig ?? null });
        }),
      );
    }

    cleanups.push(
      bus.on(ProviderRuntimeSubjects.fetchModels, async ({ payload, setResult }) => {
        const { config } = await bus.request(AdapterSubsystemSubjects.getProviderConfig, {
          id: payload.providerConfigId,
        });
        if (!config) {
          throw new Error(`Provider config '${payload.providerConfigId}' not found`);
        }

        const { bindings } = await bus.request(AdapterSubsystemSubjects.listBindingsByConfig, {
          providerConfigId: payload.providerConfigId,
        });
        const adapterDef = findBoundAdapter(getLoadedAdapters(), bindings, config.definitionId);
        if (!adapterDef) {
          throw new Error(
            bindings.length === 0
              ? `Provider config '${payload.providerConfigId}' is not bound to an adapter`
              : `No loaded adapter bound to provider config '${payload.providerConfigId}' for definition '${config.definitionId}'`,
          );
        }

        const context = await buildProviderContext(bus, payload.providerConfigId);
        const adapterId = adapterDef.options.adapterId;
        const instance = adapterId ? getAdapterInstances().get(adapterId) : undefined;
        if (!adapterId || !instance) {
          throw new Error(`Adapter instance for '${adapterDef.name}' not initialized`);
        }

        if (!('fetchModels' in instance) || typeof (instance as AdapterWithFetchModels).fetchModels !== 'function') {
          throw new Error(`Adapter '${adapterDef.name}' does not support model fetching`);
        }

        const credentials = await resolveConnectorCredentials(bus, context.credentialRefs);
        const baseUrl = context.endpointOverrides
          ? Object.values(context.endpointOverrides).find((value) => value !== undefined)
          : undefined;
        const models = await (instance as AdapterWithFetchModels).fetchModels(baseUrl, credentials);
        setResult({ models });
      }),
    );

    return () => {
      runRuntimeHandlerCleanups(cleanups);
    };
  });
}
