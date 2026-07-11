import type { IMakaioBus } from '@makaio/bus-core';
import type { AIModel, EntityUIConfig, ProtocolEndpoints, ProtocolId } from '@makaio/contracts';
import type { LoadedAdapter, AdapterInstance } from '@makaio/subsystem-adapter';
import {
  resolveAdapterRuntimeSnapshot,
  AdapterRuntimeSnapshotError,
  resolveBoundProviderAuth,
  resolveConnectorCredentials,
  type ResolvedAdapterAuth,
} from '@makaio/ai-adapters-core/config';
import { DefinitionSubjects } from '@makaio/services-core/definition';
import { ProviderRuntimeSubjects } from '@makaio/services-core/provider-runtime';
import { SettingsSubjects } from '@makaio/services-core/settings/namespace';
import { ProviderStorageSubjects, type ProviderRecord } from '@makaio/services-core/settings/storage';
import { z } from 'zod';

type LoadedProviderDefinition = LoadedAdapter['providers'][number];
type AdapterWithFetchModels = AdapterInstance & {
  fetchModels: (baseUrl: string | undefined, auth: ResolvedAdapterAuth) => Promise<AIModel[]>;
};

/** Typed failure when a live model-fetch consumer has no selected provider protocol. */
export class ProviderModelFetchProtocolError extends Error {
  public constructor() {
    super('Live model discovery requires an adapter/provider protocol declaration.');
    this.name = 'ProviderModelFetchProtocolError';
  }
}

/** Minimal atomic runtime shape needed for exact endpoint selection. */
export interface ModelFetchRuntimeSelection {
  /** Protocol declared by the selected adapter/provider reference. */
  readonly providerProtocol?: ProtocolId;
  readonly snapshot: {
    readonly context: { readonly endpointOverrides?: ProtocolEndpoints };
    readonly definition: { readonly endpoints?: ProtocolEndpoints };
  };
}

/**
 * Select only the endpoint for the active adapter/provider protocol.
 * @param runtime - Atomic selected-provider runtime snapshot
 * @returns Exact provider endpoint, when declared
 */
export function resolveModelFetchBaseUrl(runtime: ModelFetchRuntimeSelection): string | undefined {
  const protocol = runtime.providerProtocol;
  if (protocol === undefined) throw new ProviderModelFetchProtocolError();
  return runtime.snapshot.context.endpointOverrides?.[protocol] ?? runtime.snapshot.definition.endpoints?.[protocol];
}

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
 * Remove the JSON Schema dialect metadata before returning schemas to clients.
 * @param jsonSchema - Schema object produced by Zod's JSON Schema converter.
 * @returns Schema payload without top-level `$schema` metadata.
 */
function stripMetaSchema(jsonSchema: unknown): Record<string, unknown> {
  const { $schema: _, ...schema } = jsonSchema as Record<string, unknown>;
  return schema;
}

/**
 * Project a loaded adapter's provider definition into a {@link ProviderRecord}.
 *
 * Fills DB-specific fields with sensible defaults so the in-memory fallback
 * satisfies the same schema as the Drizzle-backed handler.
 * @param provider - Provider definition from a loaded adapter.
 * @returns Provider record compatible with the storage bus contract.
 */
function toProviderRecord(provider: LoadedAdapter['providers'][number]): ProviderRecord {
  const def = provider.definition;
  const now = Date.now();
  return {
    id: def.id,
    packageName: provider.providerPackageName,
    name: def.name,
    description: def.description,
    endpoints: def.endpoints,
    defaultModel: def.defaultModel,
    fastModel: def.fastModel,
    availableModels: def.availableModels ?? [],
    defaultModelFilterMode: 'show-all',
    authMethods: def.authMethods,
    capabilities: def.capabilities,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

// NOTE: do NOT change without explicit human approval
/* eslint max-lines-per-function: ["error", { "max": 190 }] */
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

    // In-memory provider storage fallback. Product hosts register a
    // Drizzle-backed handler via settingsStoragePackage at priority 0.
    // Registering at priority -1 ensures the DB handler wins when present;
    // in framework-standalone mode (e.g. CLI `serve`) this is the only
    // handler and serves provider definitions from loaded adapters.
    cleanups.push(
      bus.on(
        ProviderStorageSubjects.get,
        ({ payload, setResult }) => {
          for (const adapter of getLoadedAdapters()) {
            const match = adapter.providers.find((p) => p.definition.id === payload.id);
            if (match) {
              setResult({ provider: toProviderRecord(match) });
              return;
            }
          }
          setResult({ provider: null });
        },
        { priority: -1 },
      ),
    );

    cleanups.push(
      bus.on(
        ProviderStorageSubjects.list,
        ({ setResult }) => {
          const records: ProviderRecord[] = [];
          const seen = new Set<string>();
          for (const adapter of getLoadedAdapters()) {
            for (const provider of adapter.providers) {
              if (!seen.has(provider.definition.id)) {
                seen.add(provider.definition.id);
                records.push(toProviderRecord(provider));
              }
            }
          }
          setResult({ providers: records });
        },
        { priority: -1 },
      ),
    );

    cleanups.push(
      bus.on(ProviderRuntimeSubjects.listModelFetchAdapters, async ({ payload, setResult }) => {
        const adapterNames: string[] = [];
        for (const adapterDef of getLoadedAdapters()) {
          const adapterId = adapterDef.options.adapterId;
          const instance = adapterId ? getAdapterInstances().get(adapterId) : undefined;
          if (
            !instance ||
            !('fetchModels' in instance) ||
            typeof (instance as AdapterWithFetchModels).fetchModels !== 'function'
          ) {
            continue;
          }

          try {
            await resolveAdapterRuntimeSnapshot(bus, {
              adapterName: adapterDef.name,
              providerConfigId: payload.providerConfigId,
            });
            adapterNames.push(adapterDef.name);
          } catch (error) {
            if (!(error instanceof AdapterRuntimeSnapshotError)) {
              throw error;
            }
          }
        }
        adapterNames.sort((left, right) => left.localeCompare(right));
        setResult({ adapterNames });
      }),
    );

    cleanups.push(
      bus.on(ProviderRuntimeSubjects.fetchModels, async ({ payload, setResult }) => {
        const adapterDef = getLoadedAdapters().find((adapter) => adapter.name === payload.adapterName);
        if (!adapterDef) {
          throw new Error(`Adapter '${payload.adapterName}' is not loaded for live model discovery`);
        }

        const runtime = await resolveAdapterRuntimeSnapshot(bus, {
          adapterName: adapterDef.name,
          providerConfigId: payload.providerConfigId,
        });

        const adapterId = adapterDef.options.adapterId;
        const instance = adapterId ? getAdapterInstances().get(adapterId) : undefined;
        if (!adapterId || !instance) {
          throw new Error(`Adapter instance for '${adapterDef.name}' not initialized`);
        }

        if (!('fetchModels' in instance) || typeof (instance as AdapterWithFetchModels).fetchModels !== 'function') {
          throw new Error(`Adapter '${adapterDef.name}' does not support model fetching`);
        }

        const baseUrl = resolveModelFetchBaseUrl(runtime);
        const auth = await resolveBoundProviderAuth(runtime.boundProviderAuth, (refs) =>
          resolveConnectorCredentials(bus, refs),
        );
        const models = await (instance as AdapterWithFetchModels).fetchModels(baseUrl, auth);
        setResult({ models });
      }),
    );

    return () => {
      runRuntimeHandlerCleanups(cleanups);
    };
  });
}
