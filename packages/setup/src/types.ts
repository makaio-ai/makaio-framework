import type { IMakaioBus } from '@makaio/bus-core';

/** Identifies a discrete step in the setup flow. */
export type SetupStepId = 'consent' | 'detect' | 'install' | 'managed' | 'complete';

/** Setup execution mode. V1 only exposes interactive. */
export type SetupMode = 'interactive';

/** Configuration required to create a setup controller. */
export interface SetupConfig {
  /** Bus instance for all RPC/event communication. */
  readonly bus: IMakaioBus;
  /** Absolute path to the makaio home directory (consent file lives here). */
  readonly makaioHome: string;
  /** Host-provided restart/reconnect capability used after extension installs. */
  readonly restartAndReconnect: SetupRestartAndReconnect;
}

/**
 * Host-owned capability that restarts the current kernel host and resolves with
 * a fresh bus once the restarted kernel is ready.
 * @param bus - Current bus connected to the host that should restart.
 * @param reason - Human-readable restart reason.
 * @returns Fresh bus connected to the restarted kernel.
 */
export type SetupRestartAndReconnect = (bus: IMakaioBus, reason: string) => Promise<IMakaioBus>;

/** Persisted consent acceptance record. */
export interface ConsentState {
  /** ISO-8601 timestamp of when consent was accepted. */
  readonly acceptedAt: string;
  /** SHA-256 hash of the accepted terms document. */
  readonly documentHash: string;
  /** Semantic version tag of the accepted terms document. */
  readonly documentVersion: string;
}

/** Static catalog entry describing a known AI client. */
export interface SetupClientEntry {
  /** Stable identifier for this client (e.g. 'claude-code'). */
  readonly clientId: string;
  /** Human-readable display name. */
  readonly displayName: string;
  /** Binary name on PATH (e.g. 'claude'). */
  readonly binaryName: string;
  /** Filesystem paths whose existence signals the client is installed. */
  readonly detectPaths: readonly string[];
  /** Extension packages required for this client. */
  readonly extensionPackages: readonly string[];
}

/** Result of detecting a client on the local machine. */
export interface DetectedClient {
  /** Client catalog entry. */
  readonly entry: SetupClientEntry;
  /** Whether at least one detect path was found. */
  readonly detected: boolean;
}

/** Recommended action for a managed binary. */
export type ManagedRecommendation =
  | 'global-only'
  | 'managed-active'
  | 'activate-installed-pin'
  | 'install-and-activate-pin';

/** State of a managed binary for a detected client. */
export interface ManagedBinaryState {
  /** Client identifier. */
  readonly clientId: string;
  /** Binary name. */
  readonly binaryName: string;
  /** Recommended action. */
  readonly recommendation: ManagedRecommendation;
  /** Currently active version, if any. */
  readonly activeVersion: string | null;
  /** Pinned version from the managed catalog, if any. */
  readonly pinnedVersion: string | null;
}

/** Progress report for extension package installation. */
export interface InstallProgress {
  /** Package name being installed. */
  readonly packageName: string;
  /** Whether installation succeeded. */
  readonly success: boolean;
  /** Whether a kernel restart is required after this package. */
  readonly restartRequired: boolean;
  /** Error message if installation failed. */
  readonly error?: string;
}

/** Final result of the setup flow. */
export interface SetupResult {
  /** Whether the overall setup completed successfully. */
  readonly success: boolean;
  /** Extension packages that were installed. */
  readonly installedPackages: readonly string[];
  /** Managed binaries that were activated. */
  readonly activatedBinaries: readonly string[];
  /** Error message if setup failed. */
  readonly error?: string;
}

/** Snapshot of the entire setup flow state. */
export interface SetupState {
  /** Current step in the flow. */
  readonly step: SetupStepId;
  /** Setup execution mode. */
  readonly mode: SetupMode;
  /** Terms document text, loaded at init. */
  readonly termsText: string;
  /** Terms document version tag. */
  readonly termsVersion: string;
  /** SHA-256 hash of the terms document. */
  readonly termsHash: string;
  /** Whether consent has already been accepted (matching hash). */
  readonly consentAccepted: boolean;
  /** Detected clients from the local scan. */
  readonly detectedClients: readonly DetectedClient[];
  /** Client IDs the user has selected for installation. */
  readonly selectedClientIds: readonly string[];
  /** Extension package install progress entries. */
  readonly extensionInstallProgress: readonly InstallProgress[];
  /** Whether a kernel restart has been requested. */
  readonly restartRequested: boolean;
  /** Managed binary states (populated after restart). */
  readonly managedBinaryStates: readonly ManagedBinaryState[];
  /** Final setup result. */
  readonly result: SetupResult | null;
  /** Error state. */
  readonly error: string | null;
}

/** Actions exposed by the setup controller. */
export interface SetupActions {
  /** Accept the terms and advance from consent step. */
  acceptConsent(): Promise<void>;
  /**
   * Set selection state for a client by ID.
   * @param clientId - The client identifier to toggle.
   * @param selected - Whether the client should be selected.
   */
  setClientSelected(clientId: string, selected: boolean): void;
  /** Install selected clients, restart kernel, and activate managed binaries. */
  installSelectedClients(): Promise<void>;
}

/** Setup controller interface. */
export interface SetupController {
  /** Current setup state (immutable snapshot, replaced on every change). */
  readonly state: SetupState;
  /**
   * Subscribe to state changes.
   * @param listener - Callback invoked with the new state on each change.
   * @returns An unsubscribe function.
   */
  onChange(listener: (state: SetupState) => void): () => void;
  /** Whether the current step can advance. */
  canAdvance(): boolean;
  /** Advance the current step using the default action for that step. */
  advance(): Promise<void>;
  /** Move back one step when the current flow allows it. */
  back(): void;
  /** Step-specific controller actions. */
  readonly actions: SetupActions;
}

/** Client inventory entry from the bus client.list response, relevant to setup. */
export interface SetupClientBinaryInventory {
  /** Client identifier. */
  readonly clientId: string;
  /** Installed version strings. */
  readonly installedVersions: readonly string[];
  /** Currently active version, or null. */
  readonly activeVersion: string | null;
  /** Pinned version from the managed catalog, or null. */
  readonly pinnedVersion: string | null;
}

/** Summary of installed versions for a single client. */
export interface InstalledVersionSummary {
  /** Client identifier. */
  readonly clientId: string;
  /** Binary name. */
  readonly binaryName: string;
  /** Global (PATH) version, if detected. */
  readonly globalVersion: string | null;
  /** Managed active version, if any. */
  readonly managedActiveVersion: string | null;
  /** Managed pinned version, if any. */
  readonly managedPinnedVersion: string | null;
}
