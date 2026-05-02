/**
 * OnboardingStepRegistry - Registry for onboarding step definitions.
 *
 * Manages all onboarding steps (built-in and plugin-provided) with:
 * - Idempotent registration (StrictMode-safe)
 * - Validation on registration
 * - Sorted caching (by order field)
 * - Subscription for reactive UI updates
 * @packageDocumentation
 */

import { RegistryBase } from '../utils/RegistryBase.js';
import type { OnboardingStepDefinition } from './types.js';

/**
 * Check whether a value is a valid React component type.
 *
 * Accepts function components, class components, and exotic component objects
 * produced by `React.lazy`, `React.memo`, and `React.forwardRef` — all of
 * which carry a `$$typeof` symbol rather than being callable functions.
 * @param value - Value to check
 * @returns True when the value can be rendered as a React component
 */
function isReactComponentType(value: unknown): boolean {
  if (typeof value === 'function') return true;
  // React.lazy / React.memo / React.forwardRef return objects with $$typeof
  if (typeof value === 'object' && value !== null && '$$typeof' in value) return true;
  return false;
}

/**
 * Validate an onboarding step definition before registration.
 *
 * Checks:
 * - Non-empty id
 * - Non-empty title
 * - Finite numeric order
 * - Component is a valid React component type (function or exotic like lazy/memo)
 * @param def - Step definition to validate
 * @throws Error if validation fails with a descriptive message
 */
function validateStepDefinition(def: OnboardingStepDefinition): void {
  if (!def.id || typeof def.id !== 'string') {
    throw new Error('OnboardingStepDefinition must have a non-empty string id');
  }
  if (!def.title || typeof def.title !== 'string') {
    throw new Error(`OnboardingStepDefinition "${def.id}" must have a non-empty title`);
  }
  if (typeof def.order !== 'number' || !isFinite(def.order)) {
    throw new Error(`OnboardingStepDefinition "${def.id}" must have a finite numeric order`);
  }
  if (!isReactComponentType(def.component)) {
    throw new Error(`OnboardingStepDefinition "${def.id}" must have a component`);
  }
}

/**
 * Registry for onboarding step definitions.
 *
 * Steps are registered declaratively and sorted by their `order` field for display.
 * The registry is idempotent: re-registering a step with the same ID silently
 * replaces the previous registration, making it safe to call from React StrictMode
 * double-invoked effects.
 * @example
 * ```typescript
 * // Register a step
 * const cleanup = onboardingStepRegistry.register({
 *   id: 'welcome',
 *   title: 'Welcome',
 *   kaiState: 'wave',
 *   order: 10,
 *   component: WelcomeStep,
 * });
 *
 * // Retrieve all steps sorted by order
 * const steps = onboardingStepRegistry.getAll();
 *
 * // Subscribe to changes
 * const unsubscribe = onboardingStepRegistry.subscribe(() => {
 *   console.log('Registry changed');
 * });
 *
 * // Cleanup on unmount
 * cleanup();
 * ```
 */
export class OnboardingStepRegistry extends RegistryBase<string, OnboardingStepDefinition> {
  /**
   * Cached sorted array of all steps.
   * Invalidated on every mutation.
   */
  private cachedAll: ReadonlyArray<OnboardingStepDefinition> | null = null;

  /**
   * Register an onboarding step definition.
   *
   * Idempotent: if a step with the same ID is already registered it is
   * silently replaced. This makes registration safe to call from React
   * StrictMode double-invoked effects.
   *
   * Validates required fields before storing.
   * @param definition - The step to register
   * @returns Cleanup function that unregisters this step when called
   * @throws Error if definition validation fails
   */
  public register(definition: OnboardingStepDefinition): () => void {
    // Validate before mutating — if validation fails, the existing registration is preserved.
    validateStepDefinition(definition);

    // StrictMode-safe: unregister first if already present, then re-register.
    if (this.items.has(definition.id)) {
      this.items.delete(definition.id);
    }

    this.items.set(definition.id, definition);
    this.invalidateCache();
    this.notify();

    // Capture the definition reference so that a stale cleanup does not
    // accidentally unregister a newer definition registered under the same id.
    return () => {
      if (this.items.get(definition.id) === definition) {
        this.unregister(definition.id);
      }
    };
  }

  /**
   * Get a step definition by ID.
   * @param id - Step identifier
   * @returns Step definition or undefined if not registered
   */
  public get(id: string): OnboardingStepDefinition | undefined {
    return this.items.get(id);
  }

  /**
   * Get all registered steps, sorted ascending by order.
   *
   * Results are cached until the registry is mutated.
   * @returns Array of all step definitions, sorted by order (lower = first)
   */
  public getAll(): ReadonlyArray<OnboardingStepDefinition> {
    if (!this.cachedAll) {
      this.cachedAll = Object.freeze(Array.from(this.items.values()).sort((a, b) => a.order - b.order));
    }
    return this.cachedAll;
  }

  /**
   * Unregister a step by ID.
   *
   * Removes the step and notifies subscribers.
   * @param id - Step identifier
   * @returns True if the step was found and removed, false if not registered
   */
  public unregister(id: string): boolean {
    const removed = this.items.delete(id);
    if (removed) {
      this.invalidateCache();
      this.notify();
    }
    return removed;
  }

  /**
   * Clear all registered steps.
   *
   * Used primarily for testing or complete app teardown.
   */
  public clear(): void {
    this.items.clear();
    this.invalidateCache();
    this.notify();
  }

  /**
   * Invalidate the sorted cache.
   * Called after any mutation to force re-computation on next {@link getAll} access.
   */
  private invalidateCache(): void {
    this.cachedAll = null;
  }
}

/**
 * Global onboarding step registry instance.
 *
 * Singleton used throughout the application.
 * Built-in steps are registered at app startup.
 */
export const onboardingStepRegistry = new OnboardingStepRegistry();
