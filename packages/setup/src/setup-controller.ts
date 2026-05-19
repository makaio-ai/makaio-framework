import type { IMakaioBus } from '@makaio/bus-core';
import type {
  SetupActions,
  SetupConfig,
  SetupController,
  SetupRestartAndReconnect,
  SetupResult,
  SetupState,
} from './types.js';
import { loadConsentDocument } from './consent/consent-document.js';
import { readConsentRecord, writeConsentRecord } from './consent/consent-store.js';
import { CLIENT_CATALOG } from './detect/client-catalog.js';
import { detectClients, resolveSelectedExtensionPackages } from './detect/detect-clients.js';
import { buildManagedBinaryStates } from './detect/managed-binary.js';
import { installExtensionPackages } from './bus/package-manager-ops.js';
import { loadClientInventory, activateManagedPins } from './bus/client-ops.js';

/** Mutable state hooks shared by controller actions. */
interface SetupControllerRuntime {
  /** Returns the latest setup state snapshot. */
  getState(): SetupState;
  /**
   * Applies a state patch and notifies controller subscribers.
   * @param patch - Partial state to merge into the current state.
   */
  setState(patch: Partial<SetupState>): void;
}

/** Dependencies required by controller action handlers. */
interface SetupActionDeps {
  /** Bus instance for install RPC calls before the restart. */
  readonly bus: IMakaioBus;
  /** Absolute path to the makaio home directory. */
  readonly makaioHome: string;
  /** Host restart/reconnect capability. */
  readonly restartAndReconnect: SetupRestartAndReconnect;
  /** Runtime hooks for reading and updating controller state. */
  readonly runtime: SetupControllerRuntime;
}

/**
 * Builds the blank initial {@link SetupState} for a new controller session.
 * @param consentAccepted - Whether consent has already been accepted.
 * @param doc - The loaded consent document (text, version, hash).
 * @returns An immutable baseline state with all collection fields empty.
 */
function buildInitialState(consentAccepted: boolean, doc: { text: string; version: string; hash: string }): SetupState {
  return {
    step: consentAccepted ? 'detect' : 'consent',
    mode: 'interactive',
    termsText: doc.text,
    termsVersion: doc.version,
    termsHash: doc.hash,
    consentAccepted,
    detectedClients: [],
    selectedClientIds: [],
    extensionInstallProgress: [],
    restartRequested: false,
    managedBinaryStates: [],
    result: null,
    error: null,
  };
}

/**
 * Loads consent state and pre-detects clients when consent is already valid.
 * @param makaioHome - Absolute path to the makaio home directory.
 * @returns Initial setup state for a controller session.
 */
async function initializeSetupState(makaioHome: string): Promise<SetupState> {
  const doc = await loadConsentDocument();
  const existingRecord = await readConsentRecord(makaioHome);
  const consentAccepted = existingRecord !== null && existingRecord.documentHash === doc.hash;
  let state: SetupState = buildInitialState(consentAccepted, doc);

  if (consentAccepted) {
    const detected = await detectClients(CLIENT_CATALOG);
    const selectedIds = detected.filter((d) => d.detected).map((d) => d.entry.clientId);
    state = { ...state, detectedClients: detected, selectedClientIds: selectedIds };
  }

  return state;
}

/**
 * Executes the extension-install + restart + managed-binary activation pipeline.
 *
 * Separated from the factory function to keep each function within the
 * project's line-count limit while preserving a single, linear flow narrative.
 * @param bus - The bus instance for all RPC calls.
 * @param selectedClientIds - Client IDs the user has selected.
 * @param restartAndReconnect - Host capability that restarts and returns a fresh bus.
 * @param setState - Callback to replace the current state slice.
 */
async function runInstallFlow(
  bus: IMakaioBus,
  selectedClientIds: readonly string[],
  restartAndReconnect: SetupRestartAndReconnect,
  setState: (patch: Partial<SetupState>) => void,
): Promise<void> {
  const packages = resolveSelectedExtensionPackages(CLIENT_CATALOG, selectedClientIds);
  const selectedIds = new Set(selectedClientIds);
  const selectedCatalog = CLIENT_CATALOG.filter((entry) => selectedIds.has(entry.clientId));

  if (packages.length === 0) {
    setState({
      step: 'complete',
      result: { success: true, installedPackages: [], activatedBinaries: [] },
      error: null,
    });
    return;
  }

  const extensionSummary = await installExtensionPackages(bus, packages);
  setState({ extensionInstallProgress: extensionSummary });

  const needsRestart = extensionSummary.some((progress) => progress.restartRequired);
  let opsBus = bus;
  if (needsRestart) {
    setState({ restartRequested: true });
    opsBus = await restartAndReconnect(bus, 'setup');
  }
  setState({ restartRequested: needsRestart, step: 'managed' });

  const targets = selectedCatalog.map(({ clientId, binaryName }) => ({
    clientId,
    binaryName,
  }));
  const inventory = await loadClientInventory(opsBus, targets);
  const selectedManagedClients = new Map(
    [...inventory.managedClients].filter(([clientId]) => selectedIds.has(clientId)),
  );

  const managedStates = buildManagedBinaryStates({
    catalog: selectedCatalog,
    globalResults: inventory.globalResults,
    managedClients: selectedManagedClients,
  });
  setState({ managedBinaryStates: managedStates });

  await activateManagedPins(opsBus, selectedManagedClients);

  const result: SetupResult = {
    success: true,
    installedPackages: extensionSummary.map((p) => p.packageName),
    activatedBinaries: managedStates
      .filter((s) => s.recommendation === 'install-and-activate-pin' || s.recommendation === 'activate-installed-pin')
      .map((s) => s.clientId),
  };
  setState({ step: 'complete', result, error: null });
}

/**
 * Creates controller actions bound to the current runtime state.
 * @param deps - Action dependencies.
 * @returns Actions exposed through {@link SetupController.actions}.
 */
function createSetupActions(deps: SetupActionDeps): SetupActions {
  const { bus, makaioHome, restartAndReconnect, runtime } = deps;

  return {
    async acceptConsent(): Promise<void> {
      const current = runtime.getState();
      if (current.step !== 'consent') return;
      runtime.setState({ step: 'detect', error: null });

      try {
        await writeConsentRecord(makaioHome, {
          acceptedAt: new Date().toISOString(),
          documentHash: current.termsHash,
          documentVersion: current.termsVersion,
        });

        const detected = await detectClients(CLIENT_CATALOG);
        const selectedIds = detected.filter((d) => d.detected).map((d) => d.entry.clientId);

        runtime.setState({
          consentAccepted: true,
          detectedClients: detected,
          selectedClientIds: selectedIds,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        runtime.setState({ step: 'consent', error: message });
      }
    },

    setClientSelected(clientId: string, selected: boolean): void {
      const currentState = runtime.getState();
      if (currentState.step !== 'detect') return;
      const current = currentState.selectedClientIds;
      const isCurrentlySelected = current.includes(clientId);
      if (selected === isCurrentlySelected) return;
      const next = selected ? [...current, clientId] : current.filter((id) => id !== clientId);
      runtime.setState({ selectedClientIds: next });
    },

    async installSelectedClients(): Promise<void> {
      const current = runtime.getState();
      if (current.step !== 'detect') return;
      runtime.setState({ step: 'install', error: null });
      try {
        await runInstallFlow(bus, current.selectedClientIds, restartAndReconnect, runtime.setState);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        runtime.setState({ step: 'detect', error: message });
      }
    },
  };
}

/**
 * Creates a setup controller for the guided first-run flow.
 *
 * The controller manages a linear state machine:
 * `consent → detect → install → managed → complete`
 *
 * At construction time the consent document is loaded and any existing
 * consent record is read. If consent was already accepted (hash matches),
 * the controller starts directly at `detect` with clients pre-detected.
 *
 * State is immutable — every mutation replaces the entire state object and
 * notifies all registered `onChange` listeners.
 * @param config - Setup configuration, including host restart/reconnect capability.
 * @returns A fully initialized setup controller.
 */
export async function createSetupController(config: SetupConfig): Promise<SetupController> {
  const { bus, makaioHome, restartAndReconnect } = config;
  const listeners = new Set<(state: SetupState) => void>();
  let state = await initializeSetupState(makaioHome);

  const runtime: SetupControllerRuntime = {
    getState: () => state,
    setState: (patch) => {
      state = { ...state, ...patch };
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
  const actions = createSetupActions({ bus, makaioHome, restartAndReconnect, runtime });

  const controller: SetupController = {
    get state() {
      return state;
    },
    onChange(listener: (state: SetupState) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    canAdvance(): boolean {
      return state.step === 'consent' || state.step === 'detect';
    },
    async advance(): Promise<void> {
      if (state.step === 'consent') {
        await actions.acceptConsent();
      } else if (state.step === 'detect') {
        await actions.installSelectedClients();
      }
    },
    back(): void {
      if (state.step === 'detect' && !state.consentAccepted) {
        runtime.setState({ step: 'consent' });
      }
    },
    actions,
  };

  return controller;
}
