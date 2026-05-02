/**
 * Onboarding flow types — hooks-tier.
 *
 * Defines the runtime state, action surface, and orchestrator hook contracts
 * for the onboarding flow. Kernel-level step primitives (OnboardingContext,
 * OnboardingKaiState, and navigation-only step contracts) live in
 * `\@makaio/ui-kernel`; this module defines the hooks-tier concrete step props
 * and step definition used by the runtime orchestrator.
 * @packageDocumentation
 */

import type { AgentSelection } from '@makaio/contracts';
import type { CredentialRef } from '@makaio/contracts/config';
import type { ModelFilterMode, ModelVisibility, ProtocolEndpoints } from '@makaio/contracts/provider';
import type { BindingRecord } from '@makaio/services-core/adapter-subsystem';
import type { IMakaioBus } from '@makaio/bus-core';
import type { LogImportMode } from '@makaio/services-log-import/log-import';
import type { ExtensionInfo } from '@makaio/kernel';
import type {
  AdapterInfo,
  ComponentLike,
  OnboardingContext,
  OnboardingStepDefinition as KernelOnboardingStepDefinition,
  OnboardingStepProps as KernelOnboardingStepProps,
} from '@makaio/ui-kernel';
import type { ProviderConfigSummaryView } from '../provider-config/selectors.js';
import type { OnboardingAdapter, OnboardingClient } from './scan-onboarding-adapters.js';

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/**
 * Health check result for a single adapter.
 */
export interface HealthCheckResult {
  /** Whether the health check passed, is in progress, or failed. */
  status: 'pending' | 'success' | 'error';
  /** Human-readable message providing context for the status. */
  message?: string;
  /** Time taken to complete the check, in milliseconds. */
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Flow state
// ---------------------------------------------------------------------------

/**
 * Runtime state shared across all onboarding steps.
 *
 * Owned by the orchestrator and passed as controlled props to each step.
 * Treat as immutable inside step components — use {@link OnboardingFlowActions} to mutate.
 */
export interface OnboardingFlowState {
  /** Adapter list from the bus, refreshed after enable/load operations. */
  adapters: ReadonlyArray<AdapterInfo>;
  /** Adapter names the user has enabled during this flow. */
  enabledAdapterNames: ReadonlySet<string>;
  /** Health check results keyed by adapter name. */
  healthCheckResults: ReadonlyMap<string, HealthCheckResult>;
  /** Log import mode selections keyed by adapter name. */
  logImportSelections: ReadonlyMap<string, LogImportMode>;
  /** Default agent selection set during the preferences step. */
  defaultAgentSelection: AgentSelection | null;
  /** Full extension list from the coordinator, fetched on mount by the orchestrator. */
  extensions: ReadonlyArray<ExtensionInfo>;
  /** Per-plugin enabled toggle state, keyed by plugin name. */
  pluginEnabledStates: ReadonlyMap<string, boolean>;
  /** CLI adapter scan results, populated after {@link OnboardingFlowActions.scan} completes. */
  scanAdapters: ReadonlyArray<OnboardingAdapter>;
  /** Whether a CLI adapter scan is currently in progress. */
  isScanning: boolean;
  /** Error from the most recent {@link OnboardingFlowActions.scan} call, or null. */
  scanError: Error | null;
  /** Client-grouped scan results, populated after {@link OnboardingFlowActions.scan} completes. */
  scanClients: ReadonlyArray<OnboardingClient>;
  /** Client IDs selected by the user in step 2. */
  selectedClientIds: ReadonlySet<string>;
  /** Provider configs created during onboarding step 3. */
  providerConfigs: ReadonlyArray<ProviderConfigSummaryView>;
  /** Adapter-provider bindings created during onboarding step 4. */
  adapterProviderBindings: ReadonlyArray<BindingRecord>;
}

/**
 * Host/UI-facing provider-config draft accepted by onboarding actions.
 *
 * Host UI may collect plaintext credentials interactively before converting
 * them into stored credential refs through the host-owned create bridge.
 */
export interface OnboardingProviderConfigDraft {
  /** Provider definition identifier. */
  definitionId: string;
  /** Optional display name. */
  name?: string;
  /** Plaintext credentials captured by a host step. */
  credentials?: Record<string, string>;
  /** Pre-resolved credential refs for externally managed credentials. */
  credentialRefs?: Record<string, CredentialRef>;
  /** Optional endpoint overrides. */
  endpointOverrides?: ProtocolEndpoints;
  /** Optional per-model visibility overrides. */
  modelVisibility?: Record<string, ModelVisibility>;
  /** Optional default visibility mode. */
  modelFilterMode?: ModelFilterMode;
}

/**
 * Host-owned provider-config creator registered into the onboarding hook.
 *
 * This keeps plaintext credential capture on the host side while allowing
 * the framework-owned orchestrator to delegate provider creation through a
 * narrow inversion-of-control seam.
 */
export type OnboardingProviderConfigCreator = (
  bus: IMakaioBus,
  input: OnboardingProviderConfigDraft,
) => Promise<string>;

/**
 * Explicit registration lifecycle for the onboarding create seam.
 */
export interface OnboardingProviderConfigRegistration {
  /**
   * Register the host-owned create bridge.
   * @param creator - Host-owned create bridge.
   * @returns Cleanup that unregisters this creator when still current.
   */
  registerCreateProviderConfig: (creator: OnboardingProviderConfigCreator) => () => void;

  /**
   * Unregister the current create bridge when it matches the provided creator.
   * @param creator - Host-owned create bridge.
   */
  unregisterCreateProviderConfig: (creator: OnboardingProviderConfigCreator) => void;
}

// ---------------------------------------------------------------------------
// Flow actions
// ---------------------------------------------------------------------------

/**
 * Mutators for onboarding flow state, called by step components.
 *
 * All async methods resolve when the operation is complete.
 * Errors propagate as rejected promises — callers are responsible for handling them.
 */
export interface OnboardingFlowActions {
  /**
   * Enable an adapter by name.
   * @param adapterName - The adapter driver name to enable.
   */
  enableAdapter: (adapterName: string) => Promise<void>;

  /**
   * Disable an adapter by name.
   * @param adapterName - The adapter driver name to disable.
   */
  disableAdapter: (adapterName: string) => Promise<void>;

  /**
   * Run the health check for an adapter and record the result.
   * @param adapterName - The adapter driver name to check.
   * @returns The health check result.
   */
  runHealthCheck: (adapterName: string) => Promise<HealthCheckResult>;

  /**
   * Set the log import mode for an adapter.
   * @param adapterName - The adapter driver name.
   * @param mode - The import mode to apply.
   */
  setLogImportMode: (adapterName: string, mode: LogImportMode) => void;

  /**
   * Set or clear the default agent selection.
   * @param selection - The agent selection to persist, or null to clear.
   */
  setDefaultAgent: (selection: AgentSelection | null) => void;

  /**
   * Re-fetch the adapter list from the bus.
   */
  refreshAdapterList: () => Promise<void>;

  /**
   * Scan for installed CLI adapters and populate {@link OnboardingFlowState.scanAdapters}.
   * Sets {@link OnboardingFlowState.isScanning} during the operation.
   * Rejects with the scan error (also stored in {@link OnboardingFlowState.scanError}).
   */
  scan: () => Promise<void>;

  /**
   * Optimistically toggle a plugin's enabled state and persist the change.
   * Fire-and-forget: bus errors are logged but do not surface to the UI.
   * @param pluginName - The plugin name to toggle.
   * @param enabled - The new desired enabled state.
   */
  togglePlugin: (pluginName: string, enabled: boolean) => void;

  /**
   * Select a client in the clients step.
   * @param clientId - The client identifier to select.
   */
  selectClient: (clientId: string) => void;

  /**
   * Deselect a client in the clients step.
   * @param clientId - The client identifier to deselect.
   */
  deselectClient: (clientId: string) => void;

  /**
   * Create a provider config and add it to the onboarding state.
   * @param input - The provider config creation input.
   * @returns The ID of the created provider config.
   */
  createProviderConfig: (input: OnboardingProviderConfigDraft) => Promise<string>;

  /**
   * Delete a provider config created during onboarding.
   * @param id - The provider config ID to delete.
   */
  deleteProviderConfig: (id: string) => Promise<void>;

  /**
   * Bind a provider config to an adapter.
   * @param adapterName - The adapter name to bind to.
   * @param providerConfigId - The provider config to bind.
   */
  bindProvider: (adapterName: string, providerConfigId: string) => Promise<void>;

  /**
   * Unbind a provider config from an adapter.
   * @param adapterName - The adapter name to unbind from.
   * @param providerConfigId - The provider config to unbind.
   */
  unbindProvider: (adapterName: string, providerConfigId: string) => Promise<void>;

  /**
   * Set the default provider for an adapter.
   * @param adapterName - The adapter name.
   * @param providerConfigId - The provider config to make default.
   */
  setDefaultProvider: (adapterName: string, providerConfigId: string) => Promise<void>;

  /**
   * Refresh provider configs from the bus.
   */
  refreshProviderConfigs: () => Promise<void>;

  /**
   * Refresh adapter-provider bindings from the bus for a specific adapter.
   * @param adapterName - The adapter name to refresh bindings for.
   */
  refreshBindings: (adapterName: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Step contracts
// ---------------------------------------------------------------------------

/**
 * Concrete step props for the runtime onboarding flow.
 *
 * The kernel owns navigation-only step metadata; the hooks tier composes in
 * the live flow state and action surface that the orchestrator injects at
 * render time.
 */
export type OnboardingStepProps = KernelOnboardingStepProps & {
  /** Current snapshot of the shared flow state. */
  flowState: OnboardingFlowState;
  /** Mutators for flow state. */
  actions: OnboardingFlowActions;
};

/**
 * Concrete step definition for the runtime onboarding flow.
 *
 * This narrows the kernel step contract to the actual prop shape that host
 * and framework onboarding steps receive at runtime.
 */
export type OnboardingStepDefinition = Omit<KernelOnboardingStepDefinition, 'component'> & {
  component: ComponentLike<OnboardingStepProps>;
};

// ---------------------------------------------------------------------------
// Hook options and result
// ---------------------------------------------------------------------------

/**
 * Options passed to {@link useOnboardingFlow}.
 */
export interface UseOnboardingFlowOptions {
  /** Adapter list, client list, and plugin list for condition evaluation. */
  context: OnboardingContext;
  /** Called when onboarding flow is completed. */
  onComplete: () => void;
  /** Called when onboarding flow is skipped. */
  onSkip: () => void;
}

/**
 * Return value of {@link useOnboardingFlow}.
 */
export interface UseOnboardingFlowResult {
  /** Currently active steps (filtered by conditions, frozen at mount). */
  activeSteps: ReadonlyArray<OnboardingStepDefinition>;
  /** Index of the current step. */
  currentStepIndex: number;
  /** The current step definition. */
  currentStep: OnboardingStepDefinition;
  /** Flow state shared across all steps. */
  flowState: OnboardingFlowState;
  /** Actions for step components to call. */
  actions: OnboardingFlowActions;
  /** Navigate to the next step. */
  goNext: () => void;
  /** Navigate to the previous step. */
  goBack: () => void;
  /** Persist accumulated selections and skip the remaining onboarding steps. */
  skip: () => Promise<void>;
  /** Persist flow selections and complete the flow (call only from the final step). */
  complete: () => Promise<void>;
}

/**
 * Framework-owned onboarding hook plus its explicit host registration seam.
 */
export type UseOnboardingFlowHook = ((options: UseOnboardingFlowOptions) => UseOnboardingFlowResult) &
  OnboardingProviderConfigRegistration;
