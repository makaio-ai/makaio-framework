/**
 * Onboarding module types — kernel-tier subset.
 *
 * Defines the data contracts for the onboarding step registry:
 * step definitions, the shared context passed to condition callbacks,
 * and the props injected into step components.
 *
 * Flow-orchestration types (OnboardingFlowState, OnboardingFlowActions,
 * UseOnboardingFlowOptions, UseOnboardingFlowResult) live in
 * `\@makaio/ui-hooks` — they depend on React hooks and adapter-scan state.
 * @packageDocumentation
 */

import type { ClientRecord } from '@makaio/services-core/settings/storage';
import type { ExtensionInfo } from '@makaio/kernel';

// ---------------------------------------------------------------------------
// Kai mascot state
// ---------------------------------------------------------------------------

/**
 * Kai mascot state for a step.
 *
 * Controls the mascot animation shown alongside the step content.
 * Inlined here to avoid coupling kernel to `\@makaio/ui-components`.
 */
export type OnboardingKaiState = 'wave' | 'loading' | 'neutral' | 'success' | 'smile';

// ---------------------------------------------------------------------------
// Adapter info (mirrors @makaio/services AdapterInfoSchema)
// ---------------------------------------------------------------------------

/**
 * Information about an adapter driver.
 *
 * Structural type that mirrors `AdapterInfo` from
 * `\@makaio/services/settings/namespace` to avoid a platform-services
 * dependency at the kernel tier.
 */
export interface AdapterInfo {
  /** Adapter driver name (e.g., 'claude-code', 'openai-node') */
  adapterName: string;
  /** Human-readable display name for UI */
  displayName: string;
  /** Short description for tooltips/selection UI */
  description?: string;
  /** Whether this adapter driver is enabled in runtime config */
  enabled: boolean;
  /** Number of configured instances for this adapter */
  configCount: number;
  /** Whether this adapter currently has a registered log-import provider */
  supportsLogImport: boolean;
  /** Help links for setup and documentation. */
  helpLinks?: Array<{
    label: string;
    url: string;
  }>;
  /** Setup instructions in Markdown format. */
  instructions?: string;
  /** Readiness signal describing required configuration work, if any. */
  readiness?: 'ready' | 'missing-credentials' | 'needs-setup';
  /** Stable client identifier this adapter belongs to. */
  clientId?: string;
  /** Wire protocol this adapter speaks (for provider matching). */
  protocol?: 'anthropic' | 'openai';
  /** Provider definition IDs this adapter can run against. */
  providerDefinitionIds?: string[];
}

// ---------------------------------------------------------------------------
// Onboarding context
// ---------------------------------------------------------------------------

/**
 * Context evaluated once at the start of the onboarding flow.
 *
 * Used by step {@link OnboardingStepDefinition.condition} callbacks to decide
 * whether a step should be included in the active flow.
 */
export interface OnboardingContext {
  /** Adapters available at flow start. */
  readonly adapters: ReadonlyArray<AdapterInfo>;
  /** Extensions loaded at flow start. */
  readonly extensions: ReadonlyArray<ExtensionInfo>;
  /** Client records available at flow start. */
  readonly clients: ReadonlyArray<ClientRecord>;
}

// ---------------------------------------------------------------------------
// Step props (navigation-only; flow state lives in @makaio/ui-hooks)
// ---------------------------------------------------------------------------

/**
 * Props injected into every step component by the orchestrator.
 *
 * The flow-state and action props (flowState, actions) are injected
 * separately at the `\@makaio/ui-hooks` tier via `useOnboardingFlow`.
 * This base interface carries only the navigation callbacks so that
 * step components can be typed against the kernel contract.
 */
export interface OnboardingStepProps {
  /** Advance to the next step. */
  onNext: () => void;
  /** Return to the previous step. */
  onBack: () => void;
  /** Skip the entire onboarding flow. */
  onSkip: () => void;
  /** Complete the flow (call only from the final step). */
  onComplete: () => void;
}

// ---------------------------------------------------------------------------
// Step definition
// ---------------------------------------------------------------------------

/**
 * Declarative definition of one onboarding step.
 *
 * Steps are registered via {@link OnboardingStepRegistry} and sorted by
 * {@link OnboardingStepDefinition.order} before display.
 * @example
 * ```typescript
 * const cleanup = onboardingStepRegistry.register({
 *   id: 'welcome',
 *   title: 'Welcome',
 *   kaiState: 'wave',
 *   order: 10,
 *   component: WelcomeStep,
 * });
 * ```
 */
export interface OnboardingStepDefinition {
  /** Stable unique identifier. Must be non-empty. */
  id: string;
  /** Display title shown in the progress indicator. */
  title: string;
  /** Mascot state rendered alongside this step. */
  kaiState: OnboardingKaiState;
  /**
   * Sort order. Lower values appear earlier.
   * Built-in steps use 10–50. Plugin steps should use 100+.
   */
  order: number;
  /**
   * The step content component.
   *
   * Typed as `object` because a callable/exotic union
   * (`((...args: unknown[]) => unknown) | (new (...args: unknown[]) => unknown)`)
   * fails due to contravariance on `ComponentClass` constructor params —
   * `unknown` is not assignable to the concrete props. `object` is the widest
   * type that all `ComponentLike<P>` values satisfy while still rejecting
   * primitives. `validateStepDefinition` enforces the callable/exotic shape
   * at runtime; the hooks tier narrows back to `ComponentLike<OnboardingStepProps>`
   * at retrieval time via `narrowToHooksStepDefinitions`.
   */
  component: object;
  /**
   * Optional condition evaluated once at mount with the pre-flow adapter state.
   * Return false to exclude this step from the active flow.
   * @remarks
   * Conditions are evaluated exactly once when the flow mounts, using the
   * adapter and plugin snapshot at that moment. Do not depend on mutable
   * flow state — that state does not exist yet when conditions run.
   * @param context - Snapshot of the onboarding context at flow start.
   */
  condition?: (context: OnboardingContext) => boolean;
  /** Whether the user can skip this step individually. */
  skippable?: boolean;
}
