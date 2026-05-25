import type { IMakaioBus } from '@makaio/bus-core';
import {
  compareProjectManifestExtensions,
  extractNpmPackageName,
  findProjectManifestPath,
  parseExactExtensionSpec,
  readProjectManifest,
  type MismatchedProjectManifestExtension,
} from '@makaio/utils/project-manifest';
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
import { installExtensionPackages, listInstalledExtensionPackages } from './bus/package-manager-ops.js';
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
  /** Absolute path to the project repository root for manifest discovery. */
  readonly repoPath: string | undefined;
  /** Host restart/reconnect capability. */
  readonly restartAndReconnect: SetupRestartAndReconnect;
  /** Runtime hooks for reading and updating controller state. */
  readonly runtime: SetupControllerRuntime;
}

/**
 * Builds the manifest-related slice of {@link SetupState}.
 *
 * Encodes the invariant that all specs are selected by default when first
 * populated — `selectedManifestExtensionSpecs` always starts as a full copy
 * of `manifestExtensionSpecs`. All three initialization sites must go through
 * this helper so the invariant is defined in one place.
 * @param manifestSpecs - Extension specs declared in the project manifest.
 * @param mismatches - Manifest pins installed at a different singleton version.
 * @returns Partial state containing both manifest fields.
 */
function buildManifestState(
  manifestSpecs: readonly string[],
  mismatches: readonly MismatchedProjectManifestExtension[] = [],
): Pick<SetupState, 'manifestExtensionSpecs' | 'manifestExtensionMismatches' | 'selectedManifestExtensionSpecs'> {
  return {
    manifestExtensionSpecs: manifestSpecs,
    manifestExtensionMismatches: mismatches,
    selectedManifestExtensionSpecs: manifestSpecs,
  };
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
    ...buildManifestState([]),
    extensionInstallProgress: [],
    restartRequested: false,
    managedBinaryStates: [],
    result: null,
    error: null,
  };
}

/**
 * Discovers and loads extension specs from the project manifest.
 *
 * Walks upward from `repoPath` looking for a Makaio manifest. Returns an empty
 * array when `repoPath` is undefined, no `.git` root is found, the manifest is
 * malformed, or the manifest has no extensions declared.
 * @param repoPath - Absolute path to the repository root to search from.
 * @param bus - Bus used to read the singleton installed extension state.
 * @returns Manifest specs that are not already satisfied by installed state.
 */
async function loadManifestState(
  repoPath: string | undefined,
  bus: IMakaioBus,
): Promise<
  Pick<SetupState, 'manifestExtensionSpecs' | 'manifestExtensionMismatches' | 'selectedManifestExtensionSpecs'>
> {
  if (repoPath === undefined) return buildManifestState([]);
  const manifestPath = await findProjectManifestPath(repoPath);
  if (manifestPath === null) return buildManifestState([]);
  const manifest = await readProjectManifest(manifestPath).catch((error: unknown) => {
    console.warn(`Project manifest ignored: ${manifestPath}`, error instanceof Error ? error.message : String(error));
    return null;
  });
  if (manifest === null) return buildManifestState([]);
  const installed = await listInstalledExtensionPackages(bus);
  const diff = compareProjectManifestExtensions(manifest.extensions, installed);
  const pending = [
    ...diff.missing.map((entry) => entry.spec),
    ...diff.mismatched.map(({ manifest: entry }) => entry.spec),
  ];
  return buildManifestState(pending, diff.mismatched);
}

/**
 * Loads consent state and pre-detects clients when consent is already valid.
 * @param makaioHome - Absolute path to the makaio home directory.
 * @param repoPath - Optional absolute path to the project repository root for manifest discovery.
 * @param bus - Bus used to read installed singleton extension state.
 * @returns Initial setup state for a controller session.
 */
async function initializeSetupState(
  makaioHome: string,
  repoPath: string | undefined,
  bus: IMakaioBus,
): Promise<SetupState> {
  const doc = await loadConsentDocument();
  const existingRecord = await readConsentRecord(makaioHome);
  const consentAccepted = existingRecord !== null && existingRecord.documentHash === doc.hash;
  let state: SetupState = buildInitialState(consentAccepted, doc);

  if (consentAccepted) {
    const [detected, manifestState] = await Promise.all([
      detectClients(CLIENT_CATALOG),
      loadManifestState(repoPath, bus),
    ]);
    const selectedIds = detected.filter((d) => d.detected).map((d) => d.entry.clientId);
    state = {
      ...state,
      detectedClients: detected,
      selectedClientIds: selectedIds,
      ...manifestState,
    };
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
 * @param additionalPackageSpecs - Extra package specs (e.g. from the project manifest) to install alongside client packages.
 * @param restartAndReconnect - Host capability that restarts and returns a fresh bus.
 * @param setState - Callback to replace the current state slice.
 */
async function runInstallFlow(
  bus: IMakaioBus,
  selectedClientIds: readonly string[],
  additionalPackageSpecs: readonly string[],
  restartAndReconnect: SetupRestartAndReconnect,
  setState: (patch: Partial<SetupState>) => void,
): Promise<void> {
  const clientPackages = resolveSelectedExtensionPackages(CLIENT_CATALOG, selectedClientIds);
  const packages = mergeInstallPackageSpecs(clientPackages, additionalPackageSpecs);
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
 * Merge selected client packages with selected manifest pins.
 *
 * Manifest pins win by package name so project exact versions override catalog
 * bare package defaults.
 * @param clientPackages - Package specs contributed by selected setup clients.
 * @param manifestSpecs - Exact package specs selected from the project manifest.
 * @returns Deduplicated install package specs.
 */
function mergeInstallPackageSpecs(
  clientPackages: readonly string[],
  manifestSpecs: readonly string[],
): readonly string[] {
  const byPackage = new Map<string, string>();
  for (const spec of clientPackages) {
    byPackage.set(extractNpmPackageName(spec), spec);
  }
  for (const spec of manifestSpecs) {
    const parsed = parseExactExtensionSpec(spec);
    byPackage.set(parsed.packageName, spec);
  }
  return [...byPackage.values()];
}

/**
 * Creates controller actions bound to the current runtime state.
 * @param deps - Action dependencies.
 * @returns Actions exposed through {@link SetupController.actions}.
 */
function createSetupActions(deps: SetupActionDeps): SetupActions {
  const { bus, makaioHome, repoPath, restartAndReconnect, runtime } = deps;

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

        const [detected, manifestState] = await Promise.all([
          detectClients(CLIENT_CATALOG),
          loadManifestState(repoPath, bus),
        ]);
        const selectedIds = detected.filter((d) => d.detected).map((d) => d.entry.clientId);

        runtime.setState({
          consentAccepted: true,
          detectedClients: detected,
          selectedClientIds: selectedIds,
          ...manifestState,
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
        await runInstallFlow(bus, current.selectedClientIds, [], restartAndReconnect, runtime.setState);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        runtime.setState({ step: 'detect', error: message });
      }
    },

    setManifestExtensionSelected(spec: string, selected: boolean): void {
      const currentState = runtime.getState();
      if (currentState.step !== 'manifest') return;
      if (!currentState.manifestExtensionSpecs.includes(spec)) return;
      const current = currentState.selectedManifestExtensionSpecs;
      const isCurrentlySelected = current.includes(spec);
      if (selected === isCurrentlySelected) return;
      const next = selected ? [...current, spec] : current.filter((s) => s !== spec);
      runtime.setState({ selectedManifestExtensionSpecs: next });
    },

    async installSelectedManifestAndClients(): Promise<void> {
      const current = runtime.getState();
      if (current.step !== 'manifest') return;
      runtime.setState({ step: 'install', error: null });
      try {
        await runInstallFlow(
          bus,
          current.selectedClientIds,
          current.selectedManifestExtensionSpecs,
          restartAndReconnect,
          runtime.setState,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        runtime.setState({ step: 'manifest', error: message });
      }
    },
  };
}

/**
 * Creates a setup controller for the guided first-run flow.
 *
 * The controller manages a linear state machine:
 * `consent → detect → [manifest →] install → managed → complete`
 *
 * The `manifest` step is optional and is only entered when the project manifest
 * at `repoPath` declares one or more extension specs.
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
  const { bus, makaioHome, repoPath, restartAndReconnect } = config;
  const listeners = new Set<(state: SetupState) => void>();
  let state = await initializeSetupState(makaioHome, repoPath, bus);

  const runtime: SetupControllerRuntime = {
    getState: () => state,
    setState: (patch) => {
      state = { ...state, ...patch };
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
  const actions = createSetupActions({ bus, makaioHome, repoPath, restartAndReconnect, runtime });

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
      return state.step === 'consent' || state.step === 'detect' || state.step === 'manifest';
    },
    async advance(): Promise<void> {
      if (state.step === 'consent') {
        await actions.acceptConsent();
      } else if (state.step === 'detect') {
        if (state.manifestExtensionSpecs.length > 0) {
          runtime.setState({ step: 'manifest' });
        } else {
          await actions.installSelectedClients();
        }
      } else if (state.step === 'manifest') {
        await actions.installSelectedManifestAndClients();
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
