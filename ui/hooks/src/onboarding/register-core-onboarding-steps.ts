/**
 * Core onboarding step registration.
 *
 * Registers the seven built-in onboarding steps with the global registry.
 * Called once at app startup (alongside {@link registerCoreSettingsSections}).
 *
 * Step components are injected by the call site so the framework package does not
 * depend on the views package (which would create a circular dependency).
 * @packageDocumentation
 */

import { onboardingStepRegistry } from '@makaio/ui-kernel';
import type { OnboardingContext, ComponentLike } from '@makaio/ui-kernel';
import type { OnboardingStepDefinition, OnboardingStepProps } from './types.js';

/**
 * Step components required for core onboarding registration.
 *
 * Pass lazy-loaded components from the views package to keep the framework
 * free of any direct view dependency:
 * @example
 * ```tsx
 * import { lazy } from 'react';
 *
 * const cleanup = registerCoreOnboardingSteps({
 *   WelcomeStep:     lazy(() => import('../OnboardingView/steps/WelcomeStep')),
 *   ClientsStep:     lazy(() => import('../OnboardingView/steps/ClientsStep')),
 *   ProvidersStep:   lazy(() => import('../OnboardingView/steps/ProvidersStep')),
 *   AdaptersStep:    lazy(() => import('../OnboardingView/steps/AdaptersStep')),
 *   PreferencesStep: lazy(() => import('../OnboardingView/steps/PreferencesStep')),
 *   PluginsStep:     lazy(() => import('../OnboardingView/steps/PluginsStep')),
 *   DoneStep:        lazy(() => import('../OnboardingView/steps/DoneStep')),
 * });
 * ```
 */
export interface CoreOnboardingStepComponents {
  /** Welcome step component (always shown, order 10). */
  WelcomeStep: ComponentLike<OnboardingStepProps>;
  /** Clients selection step component (always shown, order 20). */
  ClientsStep: ComponentLike<OnboardingStepProps>;
  /** Provider config step component (always shown, order 25). */
  ProvidersStep: ComponentLike<OnboardingStepProps>;
  /** Tools (adapters) setup step component (always shown, order 30). */
  AdaptersStep: ComponentLike<OnboardingStepProps>;
  /** Preferences step component (always shown after adapters, order 35). */
  PreferencesStep: ComponentLike<OnboardingStepProps>;
  /** Plugins step component (shown when extensions are discovered, order 40). */
  PluginsStep: ComponentLike<OnboardingStepProps>;
  /** Final confirmation step component (always shown, order 50). */
  DoneStep: ComponentLike<OnboardingStepProps>;
}

/**
 * Register the seven core onboarding steps.
 *
 * Each step is assigned an order value in the range 10–50, leaving 100+ for
 * plugin-provided steps. Preferences is always included because adapter
 * enablement is mutable flow state; the Plugins step is conditioned on
 * extensions being discovered.
 * @param components - Step components injected from the views package
 * @returns Cleanup function that unregisters all core steps when called
 * @example
 * ```tsx
 * useEffect(() => {
 *   const cleanup = registerCoreOnboardingSteps({
 *     WelcomeStep:     lazy(() => import('../OnboardingView/steps/WelcomeStep')),
 *     ClientsStep:     lazy(() => import('../OnboardingView/steps/ClientsStep')),
 *     ProvidersStep:   lazy(() => import('../OnboardingView/steps/ProvidersStep')),
 *     AdaptersStep:    lazy(() => import('../OnboardingView/steps/AdaptersStep')),
 *     PreferencesStep: lazy(() => import('../OnboardingView/steps/PreferencesStep')),
 *     PluginsStep:     lazy(() => import('../OnboardingView/steps/PluginsStep')),
 *     DoneStep:        lazy(() => import('../OnboardingView/steps/DoneStep')),
 *   });
 *   return cleanup;
 * }, []);
 * ```
 */
export function registerCoreOnboardingSteps(components: CoreOnboardingStepComponents): () => void {
  const cleanups: Array<() => void> = [];
  const registerStep = (step: OnboardingStepDefinition): void => {
    cleanups.push(onboardingStepRegistry.register(step));
  };

  registerStep({
    id: 'welcome',
    title: 'Welcome',
    kaiState: 'wave',
    order: 10,
    skippable: false,
    component: components.WelcomeStep,
  });

  registerStep({
    id: 'clients',
    title: 'Clients',
    kaiState: 'neutral',
    order: 20,
    skippable: true,
    component: components.ClientsStep,
  });

  registerStep({
    id: 'providers',
    title: 'Providers',
    kaiState: 'neutral',
    order: 25,
    skippable: true,
    component: components.ProvidersStep,
  });

  registerStep({
    id: 'adapters',
    title: 'Tools',
    kaiState: 'neutral',
    order: 30,
    skippable: true,
    component: components.AdaptersStep,
  });

  registerStep({
    id: 'preferences',
    title: 'Preferences',
    kaiState: 'smile',
    order: 35,
    skippable: true,
    // The onboarding flow freezes active steps at mount. Adapter enablement is
    // mutable flow state, so gating this step at registration time would hide
    // Preferences on a true first run and make the later step unreachable.
    component: components.PreferencesStep,
  });

  registerStep({
    id: 'plugins',
    title: 'Plugins',
    kaiState: 'neutral',
    order: 40,
    skippable: true,
    /**
     * Only show when at least one plugin is discovered.
     * @param context - Snapshot of the onboarding context at flow start
     * @returns True when any extensions are available
     */
    condition: (context: OnboardingContext): boolean => context.extensions.length > 0,
    component: components.PluginsStep,
  });

  registerStep({
    id: 'done',
    title: 'All Set',
    kaiState: 'success',
    order: 50,
    skippable: false,
    component: components.DoneStep,
  });

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}
