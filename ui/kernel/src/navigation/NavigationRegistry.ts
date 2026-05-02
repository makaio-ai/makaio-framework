/**
 * NavigationRegistry - Central registry for navigation targets.
 *
 * Manages navigation items that appear in Quick Prompt, KaiTrigger hover,
 * breadcrumb dropdowns, and other navigation UI.
 *
 * Follows the same pattern as PageRegistry, WidgetRegistry, ViewRegistry.
 * @packageDocumentation
 */

import { RegistryBase } from '../utils/RegistryBase.js';
import type { NavigationTarget, NavigationQueryOptions, NavigationLevel } from './types.js';

// Mirrors the public NavigationAction union so runtime registration rejects
// malformed payloads instead of accepting them and failing later in consumers.
const validActionTypes = new Set<string>(['focus', 'page', 'command', 'callback', 'external']);

/**
 * Validate a navigation target before registration.
 * @param target - Navigation target to validate
 */
function validateTarget(target: NavigationTarget): void {
  if (!target.id || typeof target.id !== 'string') {
    throw new Error('NavigationTarget must have a non-empty string id');
  }

  if (!target.label || typeof target.label !== 'string') {
    throw new Error(`NavigationTarget "${target.id}" must have a non-empty label`);
  }

  if (!target.action || typeof target.action.type !== 'string' || !validActionTypes.has(target.action.type)) {
    throw new Error(`NavigationTarget "${target.id}" must have a valid action`);
  }

  if (typeof target.level !== 'string' || target.level.trim().length === 0) {
    throw new Error(`NavigationTarget "${target.id}" must have a non-empty level`);
  }
}

/**
 * Check if a target matches the given level.
 * @param target - Navigation target
 * @param level - Level to match
 * @returns True if target is available at this level
 */
function matchesLevel(target: NavigationTarget, level: NavigationLevel): boolean {
  if (target.level === 'any') return true;
  if (level === 'any') return true;
  return target.level === level;
}

/**
 * Registry for managing navigation targets.
 *
 * Navigation targets are items that appear in navigation UI:
 * - Quick Prompt suggestions
 * - KaiTrigger hover menu
 * - Breadcrumb dropdowns
 * @example
 * ```typescript
 * navigationRegistry.register({
 *   id: 'settings',
 *   label: 'Settings',
 *   icon: Settings,
 *   level: 'root',
 *   action: { type: 'focus', focusContext: 'settings' },
 *   group: 'quick-access',
 * });
 *
 * const targets = navigationRegistry.getByLevel('root');
 * ```
 */
export class NavigationRegistry extends RegistryBase<string, NavigationTarget> {
  private cachedAll: ReadonlyArray<NavigationTarget> | null = null;

  /**
   * Register a navigation target.
   * @param target - The navigation target to register
   * @returns Cleanup function to unregister
   * @throws If target with same ID already exists or target is invalid
   */
  public register(target: NavigationTarget): () => void {
    if (this.items.has(target.id)) {
      throw new Error(`NavigationTarget "${target.id}" is already registered`);
    }

    validateTarget(target);

    // Store an immutable snapshot so the registry cache cannot be mutated
    // through a shared object reference after registration.
    const normalized: NavigationTarget = Object.freeze({
      ...target,
      order: target.order ?? 50,
      group: target.group ?? 'navigate',
      action: Object.freeze({ ...target.action }),
    });

    this.items.set(normalized.id, normalized);
    this.invalidateCache();
    this.notify();

    // Capture normalized reference so a stale cleanup does not remove a newer
    // target registered under the same id after an unregister/re-register.
    return () => {
      if (this.items.get(normalized.id) === normalized) {
        this.unregister(normalized.id);
      }
    };
  }

  /**
   * Get navigation target by ID.
   * @param id - Target identifier
   * @returns Navigation target or undefined
   */
  public get(id: string): NavigationTarget | undefined {
    return this.items.get(id);
  }

  /**
   * Get all registered navigation targets.
   * @returns Frozen readonly array of all targets sorted by order
   */
  public getAll(): ReadonlyArray<NavigationTarget> {
    if (!this.cachedAll) {
      this.cachedAll = Object.freeze(Array.from(this.items.values()).sort((a, b) => (a.order ?? 50) - (b.order ?? 50)));
    }
    return this.cachedAll;
  }

  /**
   * Query navigation targets with filters.
   * @param options - Query options
   * @returns Filtered and sorted targets
   */
  public query(options: NavigationQueryOptions = {}): NavigationTarget[] {
    const { level, group, includeHidden = false } = options;

    return this.getAll().filter((target) => {
      // Level filter
      if (level && !matchesLevel(target, level)) {
        return false;
      }

      // Group filter
      if (group && target.group !== group) {
        return false;
      }

      // Visibility check
      if (!includeHidden && target.when) {
        try {
          if (!target.when()) return false;
        } catch (error) {
          console.warn('[NavigationRegistry] Target "when" callback threw, hiding target.', {
            targetId: target.id,
            error,
          });
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Get targets available at a specific navigation level.
   * @param level - Navigation level
   * @returns Targets available at this level
   */
  public getByLevel(level: NavigationLevel): NavigationTarget[] {
    return this.query({ level });
  }

  /**
   * Get targets in a specific group.
   * @param group - Navigation group
   * @returns Targets in this group
   */
  public getByGroup(group: NavigationTarget['group']): NavigationTarget[] {
    return this.query({ group });
  }

  /**
   * Unregister a navigation target by ID.
   * @param id - Target identifier
   * @returns True if target was unregistered, false if not found
   */
  public unregister(id: string): boolean {
    const result = this.items.delete(id);
    if (result) {
      this.invalidateCache();
      this.notify();
    }
    return result;
  }

  /**
   * Clear all registered navigation targets.
   */
  public clear(): void {
    this.items.clear();
    this.invalidateCache();
    this.notify();
  }

  /**
   * Invalidate internal caches.
   */
  private invalidateCache(): void {
    this.cachedAll = null;
  }
}

/** Global navigation registry instance */
export const navigationRegistry = new NavigationRegistry();
