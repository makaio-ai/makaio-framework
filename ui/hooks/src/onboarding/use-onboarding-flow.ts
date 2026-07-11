/* eslint max-lines: ["error", { "max": 680 }] */
/* eslint max-lines-per-function: ["error", { "max": 540 }] */
/**
 * useOnboardingFlow — core onboarding flow orchestrator.
 * Freezes the active step list on mount and owns all shared flow state/navigation.
 * @packageDocumentation
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { MakaioBus } from '@makaio/bus-core';
import { useBus } from '../bus/bus-provider.js';
import { AdapterSubjects } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '@makaio/services-core/adapter-runtime';
import { AdapterSubsystemSubjects, type BindingRecord } from '@makaio/services-core/adapter-subsystem';
import { LogImportSubjects } from '@makaio/services-log-import/log-import';
import type { AgentSelection, ResolvedProviderContext } from '@makaio/contracts';
import type { LogImportMode } from '@makaio/services-log-import/log-import';
import { SettingsSubjects } from '@makaio/services-core/settings/namespace';
import { ExtensionConfigStorageSubjects } from '@makaio/services-core/settings/storage/extension-configs/namespace';
import { ExtensionSubjects } from '@makaio/kernel';
import type { ExtensionInfo } from '@makaio/kernel';
import { resolveRuntimeProviderContext } from '@makaio/services-core/provider-context';
import { onboardingStepRegistry, findCategory, deriveDefaultEnabled } from '@makaio/ui-kernel';
import type { OnboardingStepDefinition as KernelOnboardingStepDefinition } from '@makaio/ui-kernel';
import { persistPluginEnabled } from './plugin-persistence.js';
import type { PersistedExtensionConfigEntry } from './plugin-persistence.js';
import { useAppContext } from '../state/app-context-store.js';
import { useProviderStore } from '../state/provider-store.js';
import { setOnboardingCompleted } from './skip-flag.js';
import { scanOnboarding } from './scan-onboarding-adapters.js';
import type { OnboardingAdapter, OnboardingClient } from './scan-onboarding-adapters.js';
import { listProviderConfigSummaryViews, type ProviderConfigSummaryView } from '../provider-config/selectors.js';
import { authDraftRequiresStorage, compileProviderConfigAuthDraft } from '../provider-config/auth-draft.js';
import type {
  OnboardingFlowActions,
  OnboardingFlowState,
  HealthCheckResult,
  OnboardingProviderConfigDraft,
  OnboardingProviderConfigCreator,
  OnboardingStepDefinition,
  UseOnboardingFlowHook,
  UseOnboardingFlowOptions,
  UseOnboardingFlowResult,
} from './types.js';
const HEALTH_CHECK_TIMEOUT_MS = 30_000;
const PERSIST_TIMEOUT_MS = 8_000;
const HEALTH_CHECK_PROMPT = 'Reply with the single word: OK';
let onboardingProviderConfigRegistration: { creator: OnboardingProviderConfigCreator; count: number } | null = null;
/**
 * @param creator - Host-owned create bridge.
 * @returns Cleanup that unregisters this creator.
 */
export function registerCreateProviderConfig(creator: OnboardingProviderConfigCreator): () => void {
  if (onboardingProviderConfigRegistration === null) {
    onboardingProviderConfigRegistration = { creator, count: 1 };
  } else if (onboardingProviderConfigRegistration.creator === creator) {
    onboardingProviderConfigRegistration.count += 1;
  } else {
    throw new Error('useOnboardingFlow: only one host-owned create bridge may be registered at a time.');
  }
  return () => unregisterCreateProviderConfig(creator);
}
/**
 * @param creator - Host-owned create bridge.
 */
export function unregisterCreateProviderConfig(creator: OnboardingProviderConfigCreator): void {
  if (onboardingProviderConfigRegistration?.creator !== creator) return;
  if (onboardingProviderConfigRegistration.count === 1) {
    onboardingProviderConfigRegistration = null;
    return;
  }
  onboardingProviderConfigRegistration.count -= 1;
}
/**
 * @param steps - Kernel step definitions.
 * @returns Hooks-tier step definitions.
 */
function narrowToHooksStepDefinitions(
  steps: ReadonlyArray<KernelOnboardingStepDefinition>,
): ReadonlyArray<OnboardingStepDefinition> {
  return steps as ReadonlyArray<OnboardingStepDefinition>;
}
/**
 * @param onComplete - Completion callback.
 */
function finalizeOnboardingCompletion(onComplete: () => void): void {
  try {
    setOnboardingCompleted();
  } catch (err) {
    console.error('[useOnboardingFlow] Failed to persist completion flag:', err);
  } finally {
    onComplete();
  }
}
/**
 * @param input - Onboarding draft.
 * @param refreshProviderConfigs - Refresh callback after a successful create.
 * @returns Created config ID.
 */
async function createOnboardingProviderConfig(
  input: OnboardingProviderConfigDraft,
  refreshProviderConfigs: () => Promise<void>,
): Promise<string> {
  const creator = onboardingProviderConfigRegistration?.creator ?? null;
  if (creator) {
    const configId = await creator(MakaioBus, input);
    await refreshProviderConfigs();
    return configId;
  }
  if (authDraftRequiresStorage(input.auth)) {
    throw new Error('useOnboardingFlow: plaintext provider-config creation requires a host-owned create bridge.');
  }
  const { auth } = compileProviderConfigAuthDraft(input.auth);
  const { auth: _authDraft, ...configInput } = input;
  const { config } = await MakaioBus.request(AdapterSubsystemSubjects.createProviderConfig, {
    ...configInput,
    auth,
  });
  await refreshProviderConfigs();
  return config.id;
}
/**
 * Build the provider context for a health-check inference call.
 *
 * Selects the effective default binding for the adapter and resolves its
 * adapter-qualified atomic runtime context.
 * Returns `undefined` for adapters with no usable provider binding
 * (e.g. local claude-code).
 * @param adapterName - Adapter type name to look up
 * @returns Resolved provider context, or undefined when no binding exists
 * @throws RuntimeProviderContextResolutionError when the selected binding is unavailable or incompatible
 */
async function resolveHealthCheckProviderContext(adapterName: string): Promise<ResolvedProviderContext | undefined> {
  const bindingResult = await MakaioBus.requestOptional(AdapterSubsystemSubjects.getDefaultBinding, { adapterName });
  if (!bindingResult.handled || !bindingResult.data.binding) {
    return undefined;
  }
  const { binding } = bindingResult.data;
  return resolveRuntimeProviderContext(MakaioBus, {
    adapterName: binding.adapterName,
    providerConfigId: binding.providerConfigId,
  });
}
/**
 * Core orchestrator hook for the onboarding flow.
 * Evaluates step conditions once at mount to build the frozen active step list.
 * Manages navigation and owns all shared flow state. Bus operations are
 * encapsulated behind the returned {@link OnboardingFlowActions}.
 *
 * Health checks use a per-adapter AbortController map and abort all controllers on unmount.
 * @param options - Context, and completion/skip callbacks
 * @returns Flow state, active steps, navigation helpers, and actions
 */
function useOnboardingFlowImpl({ context, onComplete, onSkip }: UseOnboardingFlowOptions): UseOnboardingFlowResult {
  const { setDefaultSelection } = useAppContext();
  const bus = useBus();
  // Freeze the active step list on first render — conditions are evaluated exactly once.
  const [activeSteps] = useState<ReadonlyArray<OnboardingStepDefinition>>(() => {
    const all = narrowToHooksStepDefinitions(onboardingStepRegistry.getAll());
    return Object.freeze(all.filter((step) => step.condition === undefined || step.condition(context)));
  });
  const [currentStepIndex, setCurrentStepIndex] = useState(0);

  const [adapters, setAdapters] = useState(context.adapters);
  const [enabledAdapterNames, setEnabledAdapterNames] = useState<ReadonlySet<string>>(
    () => new Set(context.adapters.filter((adapter) => adapter.enabled).map((adapter) => adapter.adapterName)),
  );
  const [healthCheckResults, setHealthCheckResults] = useState<ReadonlyMap<string, HealthCheckResult>>(() => new Map());
  const [logImportSelections, setLogImportSelections] = useState<ReadonlyMap<string, LogImportMode>>(() => new Map());
  const [defaultAgentSelection, setDefaultAgentSelectionState] = useState<AgentSelection | null>(null);
  const [extensionList, setExtensionList] = useState<ReadonlyArray<ExtensionInfo>>(() => context.extensions);
  const [pluginEnabledStates, setPluginEnabledStates] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [scanAdapters, setScanAdapters] = useState<ReadonlyArray<OnboardingAdapter>>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState<Error | null>(null);
  const [selectedClientIds, setSelectedClientIds] = useState<ReadonlySet<string>>(() => new Set());
  const [scanClients, setScanClients] = useState<ReadonlyArray<OnboardingClient>>([]);
  const [providerConfigs, setProviderConfigs] = useState<ReadonlyArray<ProviderConfigSummaryView>>([]);
  const [adapterProviderBindings, setAdapterProviderBindings] = useState<ReadonlyArray<BindingRecord>>([]);
  const persistedPluginConfigs = useRef<Map<string, PersistedExtensionConfigEntry>>(new Map());
  const pluginFetchRunIdRef = useRef(0);
  const scanRunIdRef = useRef(0);
  const healthCheckAbortMap = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    const currentRunId = ++pluginFetchRunIdRef.current;
    const isCurrentRun = () => pluginFetchRunIdRef.current === currentRunId;

    const doFetch = async () => {
      try {
        const [extensionsResult, storedConfigsResult] = await Promise.all([
          MakaioBus.request(ExtensionSubjects.list, {}),
          MakaioBus.request(ExtensionConfigStorageSubjects.list, {}),
        ]);
        if (!isCurrentRun()) return;

        const storedByName = new Map<string, { id: string; enabled: boolean; config?: Record<string, unknown> }>();
        for (const row of storedConfigsResult.extensionConfigs) {
          if (row.scope === 'default' && !storedByName.has(row.extensionName)) {
            storedByName.set(row.extensionName, { id: row.id, enabled: row.enabled, config: row.config });
          }
        }

        const initial = new Map<string, boolean>();
        const persisted = new Map<string, PersistedExtensionConfigEntry>();
        for (const ext of extensionsResult.extensions) {
          const stored = storedByName.get(ext.name);
          if (stored !== undefined) {
            initial.set(ext.name, stored.enabled);
            persisted.set(ext.name, { id: stored.id, config: stored.config });
          }
        }

        setExtensionList(extensionsResult.extensions);
        setPluginEnabledStates(initial);
        persistedPluginConfigs.current = persisted;
      } catch (err) {
        if (!isCurrentRun()) return;
        console.error('[useOnboardingFlow] Failed to load extension list:', err);
      }
    };

    void doFetch();
  }, []);

  useEffect(
    () => () => {
      for (const ctrl of healthCheckAbortMap.current.values()) ctrl.abort();
      healthCheckAbortMap.current.clear();
    },
    [],
  );

  const refreshAdapterList = useCallback(async (): Promise<void> => {
    const { adapters: fresh } = await MakaioBus.request(SettingsSubjects.adapter.list, {});
    setAdapters(fresh);
    setEnabledAdapterNames(new Set(fresh.filter((a) => a.enabled).map((a) => a.adapterName)));
  }, []);

  const enableAdapter = useCallback(
    async (adapterName: string): Promise<void> => {
      const setEnabledResult = await MakaioBus.request(SettingsSubjects.adapter.setEnabled, {
        adapterName,
        enabled: true,
      });
      if (!setEnabledResult.success) return;

      await refreshAdapterList();
      useProviderStore.getState().invalidate();
    },
    [refreshAdapterList],
  );

  const disableAdapter = useCallback(
    async (adapterName: string): Promise<void> => {
      const setEnabledResult = await MakaioBus.request(SettingsSubjects.adapter.setEnabled, {
        adapterName,
        enabled: false,
      });
      if (!setEnabledResult.success) return;

      setEnabledAdapterNames((prev) => {
        const next = new Set(prev);
        next.delete(adapterName);
        return next;
      });
      await refreshAdapterList();
      useProviderStore.getState().invalidate();
    },
    [refreshAdapterList],
  );

  const runHealthCheck = useCallback(async (adapterName: string): Promise<HealthCheckResult> => {
    setHealthCheckResults((prev) => new Map([...prev, [adapterName, { status: 'pending' }]]));
    healthCheckAbortMap.current.get(adapterName)?.abort();
    const abortController = new AbortController();
    healthCheckAbortMap.current.set(adapterName, abortController);
    const clearCurrentAbortController = (): void => {
      if (healthCheckAbortMap.current.get(adapterName) === abortController) {
        healthCheckAbortMap.current.delete(adapterName);
      }
    };

    let adapterId: string;
    try {
      const resolved = await MakaioBus.request(
        AdapterRuntimeSubjects.resolveId,
        { adapterName },
        {
          signal: abortController.signal,
        },
      );
      adapterId = resolved.adapterId;
    } catch (err) {
      clearCurrentAbortController();
      if (abortController.signal.aborted) return { status: 'pending' }; // guard: stale resolveId errors
      const message = err instanceof Error ? err.message : String(err);
      const result: HealthCheckResult = {
        status: 'error',
        message: `Could not resolve adapter "${adapterName}": ${message}`,
      };
      setHealthCheckResults((prev) => new Map([...prev, [adapterName, result]]));
      return result;
    }

    try {
      if (abortController.signal.aborted) return { status: 'pending' };
      const providerContext = await resolveHealthCheckProviderContext(adapterName);
      if (abortController.signal.aborted) return { status: 'pending' };
      const startMs = Date.now();
      const inferPayload = {
        adapterId,
        prompt: HEALTH_CHECK_PROMPT,
        ...(providerContext && { providerContext }),
      };
      await MakaioBus.request(AdapterSubjects.infer, inferPayload, {
        timeout: HEALTH_CHECK_TIMEOUT_MS,
        signal: abortController.signal,
      });

      if (abortController.signal.aborted) return { status: 'pending' };

      const result: HealthCheckResult = { status: 'success', durationMs: Date.now() - startMs };
      setHealthCheckResults((prev) => new Map([...prev, [adapterName, result]]));
      return result;
    } catch (err) {
      if (abortController.signal.aborted) return { status: 'pending' };
      const message = err instanceof Error ? err.message : String(err);
      const result: HealthCheckResult = { status: 'error', message };
      setHealthCheckResults((prev) => new Map([...prev, [adapterName, result]]));
      return result;
    } finally {
      clearCurrentAbortController();
    }
  }, []);

  const setLogImportMode = useCallback((adapterName: string, mode: LogImportMode): void => {
    setLogImportSelections((prev) => new Map([...prev, [adapterName, mode]]));
  }, []);

  const setDefaultAgent = useCallback((selection: AgentSelection | null): void => {
    setDefaultAgentSelectionState(selection);
  }, []);

  const scan = useCallback(async (): Promise<void> => {
    const runId = ++scanRunIdRef.current;
    setIsScanning(true);
    setScanError(null);
    try {
      const { adapters: adapterResults, clients: clientResults } = await scanOnboarding();
      if (scanRunIdRef.current !== runId) return;
      setScanAdapters(adapterResults);
      setScanClients(clientResults);
      const foundIds = new Set(clientResults.filter((c) => c.found).map((c) => c.clientId));
      setSelectedClientIds((prev) => {
        if (prev.size === 0) return foundIds;
        return new Set([...prev].filter((id) => foundIds.has(id)));
      });
    } catch (err) {
      if (scanRunIdRef.current !== runId) return;
      const error = err instanceof Error ? err : new Error(String(err));
      setScanError(error);
      throw error;
    } finally {
      if (scanRunIdRef.current === runId) {
        setIsScanning(false);
      }
    }
  }, []);

  const togglePlugin = useCallback(
    (pluginName: string, enabled: boolean): void => {
      setPluginEnabledStates((prev) => new Map([...prev, [pluginName, enabled]]));
      void persistPluginEnabled(pluginName, enabled, persistedPluginConfigs.current, bus).catch((err: unknown) => {
        console.error(`[useOnboardingFlow] Failed to persist plugin toggle for ${pluginName}:`, err);
      });
    },
    [bus],
  );

  const selectClient = useCallback(
    (clientId: string): void => setSelectedClientIds((prev) => new Set([...prev, clientId])),
    [],
  );

  const deselectClient = useCallback((clientId: string): void => {
    setSelectedClientIds((prev) => {
      const next = new Set(prev);
      next.delete(clientId);
      return next;
    });
  }, []);

  const refreshProviderConfigs = useCallback(async (): Promise<void> => {
    setProviderConfigs(await listProviderConfigSummaryViews(MakaioBus));
  }, []);

  const createProviderConfig = useCallback(
    async (input: OnboardingProviderConfigDraft): Promise<string> =>
      createOnboardingProviderConfig(input, refreshProviderConfigs),
    [refreshProviderConfigs],
  );

  const deleteProviderConfig = useCallback(
    async (id: string): Promise<void> => {
      await MakaioBus.request(AdapterSubsystemSubjects.deleteProviderConfig, { id });
      await refreshProviderConfigs();
      setAdapterProviderBindings((prev) => prev.filter((b) => b.providerConfigId !== id));
    },
    [refreshProviderConfigs],
  );

  /**
   * Fetches bindings for a single adapter from the bus and updates state.
   * Shared by {@link bindProvider}, {@link unbindProvider}, and {@link refreshBindings}.
   * @param adapterName - The adapter name whose bindings should be refreshed.
   */
  const refreshBindingsForAdapter = useCallback(async (adapterName: string): Promise<void> => {
    const { bindings } = await MakaioBus.request(AdapterSubsystemSubjects.listBindings, { adapterName });
    setAdapterProviderBindings((prev) => {
      const without = prev.filter((b) => b.adapterName !== adapterName);
      return [...without, ...bindings];
    });
  }, []);

  const bindProvider = useCallback(
    async (adapterName: string, providerConfigId: string): Promise<void> => {
      await MakaioBus.request(AdapterSubsystemSubjects.bind, { adapterName, providerConfigId });
      await refreshBindingsForAdapter(adapterName);
    },
    [refreshBindingsForAdapter],
  );

  const unbindProvider = useCallback(
    async (adapterName: string, providerConfigId: string): Promise<void> => {
      await MakaioBus.request(AdapterSubsystemSubjects.unbind, { adapterName, providerConfigId });
      await refreshBindingsForAdapter(adapterName);
    },
    [refreshBindingsForAdapter],
  );

  const setDefaultProvider = useCallback(
    async (adapterName: string, providerConfigId: string): Promise<void> => {
      await MakaioBus.request(AdapterSubsystemSubjects.setDefaultBinding, {
        adapterName,
        providerConfigId,
      });
      await refreshBindingsForAdapter(adapterName);
    },
    [refreshBindingsForAdapter],
  );

  const actions: OnboardingFlowActions = useMemo(
    () => ({
      enableAdapter,
      disableAdapter,
      runHealthCheck,
      setLogImportMode,
      setDefaultAgent,
      refreshAdapterList,
      togglePlugin,
      scan,
      selectClient,
      deselectClient,
      createProviderConfig,
      deleteProviderConfig,
      bindProvider,
      unbindProvider,
      setDefaultProvider,
      refreshProviderConfigs,
      refreshBindings: refreshBindingsForAdapter,
    }),
    [
      enableAdapter,
      disableAdapter,
      runHealthCheck,
      setLogImportMode,
      setDefaultAgent,
      refreshAdapterList,
      togglePlugin,
      scan,
      selectClient,
      deselectClient,
      createProviderConfig,
      deleteProviderConfig,
      bindProvider,
      unbindProvider,
      setDefaultProvider,
      refreshProviderConfigs,
      refreshBindingsForAdapter,
    ],
  );

  const goNext = useCallback(() => {
    setCurrentStepIndex((i) => Math.min(i + 1, activeSteps.length - 1));
  }, [activeSteps.length]);

  const goBack = useCallback(() => {
    setCurrentStepIndex((i) => Math.max(i - 1, 0));
  }, []);

  /** Persist all user selections from the flow. Called by skip and complete.
   * @param persistPluginDefaults - Write category defaults for untouched extensions.
   */
  const persistSelections = useCallback(
    async (persistPluginDefaults: boolean): Promise<void> => {
      if (defaultAgentSelection) {
        setDefaultSelection(defaultAgentSelection);
      }
      const modeEntries = Array.from(logImportSelections.entries());
      await Promise.all(
        modeEntries.map(([adapterName, mode]) =>
          MakaioBus.request(LogImportSubjects.setMode, { adapterName, mode }, { timeout: PERSIST_TIMEOUT_MS }),
        ),
      );
      await Promise.all(
        Array.from(pluginEnabledStates.entries()).map(([pluginName, enabled]) =>
          persistPluginEnabled(pluginName, enabled, persistedPluginConfigs.current, bus),
        ),
      );
      if (persistPluginDefaults) {
        for (const ext of extensionList) {
          if (!pluginEnabledStates.has(ext.name)) {
            const category = findCategory(ext.name);
            const defaultEnabled = deriveDefaultEnabled(category);
            void persistPluginEnabled(ext.name, defaultEnabled, persistedPluginConfigs.current, bus).catch(
              (err: unknown) => {
                console.error(`[useOnboardingFlow] Failed to persist default extension state for ${ext.name}:`, err);
              },
            );
          }
        }
      }
    },
    [bus, logImportSelections, defaultAgentSelection, setDefaultSelection, extensionList, pluginEnabledStates],
  );

  const skip = useCallback(async (): Promise<void> => {
    try {
      await persistSelections(false);
    } catch (err) {
      console.error('[useOnboardingFlow] Failed to persist selections on skip:', err);
    } finally {
      onSkip();
    }
  }, [persistSelections, onSkip]);

  const complete = useCallback(async (): Promise<void> => {
    try {
      await persistSelections(true);
    } catch (err) {
      console.error('[useOnboardingFlow] Failed to persist selections on complete:', err);
    } finally {
      finalizeOnboardingCompletion(onComplete);
    }
  }, [persistSelections, onComplete]);

  const flowState: OnboardingFlowState = useMemo(
    () => ({
      adapters,
      enabledAdapterNames,
      healthCheckResults,
      logImportSelections,
      defaultAgentSelection,
      extensions: extensionList,
      pluginEnabledStates,
      scanAdapters,
      isScanning,
      scanError,
      scanClients,
      selectedClientIds,
      providerConfigs,
      adapterProviderBindings,
    }),
    [
      adapters,
      enabledAdapterNames,
      healthCheckResults,
      logImportSelections,
      defaultAgentSelection,
      extensionList,
      pluginEnabledStates,
      scanAdapters,
      isScanning,
      scanError,
      scanClients,
      selectedClientIds,
      providerConfigs,
      adapterProviderBindings,
    ],
  );

  const currentStep = activeSteps[currentStepIndex] ?? activeSteps[0];
  if (currentStep === undefined) {
    throw new Error(
      'useOnboardingFlow: no active steps found. ' +
        'Call registerCoreOnboardingSteps() before mounting the onboarding flow.',
    );
  }

  return {
    activeSteps,
    currentStepIndex,
    currentStep,
    flowState,
    actions,
    goNext,
    goBack,
    skip,
    complete,
  };
}

export const useOnboardingFlow: UseOnboardingFlowHook = Object.assign(useOnboardingFlowImpl, {
  registerCreateProviderConfig,
  unregisterCreateProviderConfig,
});
