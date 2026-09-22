import type { IMakaioBus } from '@makaio/bus-core';
import type {
  AIModel,
  EntityUIConfig,
  ExtensionOperatorConfigEntry,
  ProtocolEndpoints,
  ProtocolId,
} from '@makaio/contracts';
import type { ExtensionConfigResolution } from '@makaio/kernel';
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
import { isRecord } from '@makaio/utils';
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

/**
 * Build an operator provenance snapshot for the config schema response.
 *
 * The owned key set comes from the operator entry itself, so it is reported
 * whenever an operator source supplies config — resolution may fail, but the
 * operator layer still shadows those keys at merge time, so they must stay
 * locked in the UI.
 *
 * Values are reported separately and only when the extension's configuration
 * actually resolved. They are then the *effective* values — the ones the
 * extension receives, after every schema transform (e.g. `.trim()`). Raw
 * operator values are never emitted: the field carries no marker
 * distinguishing the two, so a consumer that received raw values for some
 * extensions and resolved values for others could not tell them apart and
 * would render an operator-owned field differently depending on state.
 *
 * A resolution that fell back to schema defaults is treated the same as no
 * resolution at all. Its record holds the schema's own defaults with every
 * configuration layer discarded, so reporting it would label schema defaults
 * as operator-managed values the extension never received.
 * @param operatorEntry - Raw operator config entry for the extension.
 * @param resolution - Config resolution for the extension, or `undefined`.
 * @returns Provenance object, or `undefined` when there is no operator entry
 *   or the entry is a failure rather than a config entry.
 */
function buildOperatorProvenance(
  operatorEntry: ExtensionOperatorConfigEntry | undefined,
  resolution: ExtensionConfigResolution | undefined,
): { source: string; keys: string[]; values?: Record<string, unknown> } | undefined {
  if (operatorEntry?.kind !== 'config') return undefined;
  const keys = Object.keys(operatorEntry.config);
  const resolved = resolution && !resolution.usedSchemaDefaults ? resolution.config : undefined;
  if (!isRecord(resolved)) return { source: operatorEntry.source, keys };
  return {
    source: operatorEntry.source,
    keys,
    values: Object.fromEntries(keys.filter((key) => key in resolved).map((key) => [key, resolved[key]])),
  };
}

// NOTE: do NOT change the eslint override on the next line without explicit human approval
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
 * @param getExtensionOperatorConfig - Accessor for the operator config entry for a
 *   given extension. It supplies the set of operator-owned keys; their values
 *   come from `getResolvedExtensionConfig`. Extensions without a `configSchema`
 *   never receive provenance (kernel drops the operator layer in that case).
 * @param getResolvedExtensionConfig - Accessor returning the extension's config
 *   resolution, independent of its lifecycle state. Its config is what the
 *   config schema response reports for operator-owned keys, so every schema
 *   transform (e.g. `.trim()`) is reflected. When it is omitted, yields no
 *   record, or reports that resolution fell back to schema defaults,
 *   `operatorConfig` still reports the owned keys but carries no `values`
 *   rather than values the extension never received.
 * @returns Cleanup function that unregisters all runtime handlers.
 */
export function registerRuntimeHandlers(
  bus: IMakaioBus,
  getLoadedAdapters: () => readonly LoadedAdapter[],
  getAdapterInstances: () => ReadonlyMap<string, AdapterInstance>,
  getExtension?: (name: string) => { configSchema?: z.ZodType; uiConfig?: EntityUIConfig } | undefined,
  getExtensionOperatorConfig?: (extensionName: string) => ExtensionOperatorConfigEntry | undefined,
  getResolvedExtensionConfig?: (name: string) => ExtensionConfigResolution | undefined,
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

          const operatorEntry = getExtensionOperatorConfig?.(payload.extensionName);
          // Only expose provenance for successfully resolved config entries with
          // a schema — kernel resolve-config drops the operator layer without a
          // schema, so there is nothing to lock in that case. Failure entries are
          // already surfaced as extension activation errors.
          const operatorConfig = buildOperatorProvenance(
            operatorEntry,
            getResolvedExtensionConfig?.(payload.extensionName),
          );

          const schema = stripMetaSchema(z.toJSONSchema(pkg.configSchema));
          setResult({ hasSchema: true, schema, uiConfig: pkg.uiConfig ?? null, operatorConfig });
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
