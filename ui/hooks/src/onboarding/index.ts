/**
 * Onboarding hooks module public exports.
 * @packageDocumentation
 */

export { registerCoreOnboardingSteps, type CoreOnboardingStepComponents } from './register-core-onboarding-steps.js';

export {
  getOnboardingSkipped,
  setOnboardingSkipped,
  clearOnboardingSkipped,
  getOnboardingCompleted,
  setOnboardingCompleted,
  clearOnboardingCompleted,
} from './skip-flag.js';

export { useOnboardingFlow } from './use-onboarding-flow.js';

export type {
  HealthCheckResult,
  OnboardingStepDefinition,
  OnboardingFlowState,
  OnboardingFlowActions,
  OnboardingStepProps,
  OnboardingProviderConfigDraft,
  OnboardingProviderConfigCreator,
  UseOnboardingFlowOptions,
  UseOnboardingFlowResult,
} from './types.js';

export type { PersistedExtensionConfigEntry } from './plugin-persistence.js';
export { persistPluginEnabled } from './plugin-persistence.js';

export type { OnboardingAdapter, OnboardingClient, ScanContext } from './scan-onboarding-adapters.js';

export {
  scanOnboardingAdapters,
  scanOnboardingClients,
  scanOnboarding,
  buildScanContext,
} from './scan-onboarding-adapters.js';
