/**
 * PageSectionRegistry - Central registry for page section definitions
 *
 * Page sections register their definitions at app startup.
 * Consumers query available sections for navigation and routing within parent pages.
 * @packageDocumentation
 */

import type { PageSectionDefinition } from './page-section-types.js';
import { RegistryBase } from '../utils/RegistryBase.js';

/**
 * Registry for managing page section definitions.
 *
 * Provides registration, lookup, and filtering by parent page and category.
 * Uses composite keys (parentPageId:sectionId) and caching for performance.
 */
export class PageSectionRegistry extends RegistryBase<string, PageSectionDefinition> {
  private cachedByParent: Map<string, PageSectionDefinition[]> | null = null;

  /**
   * Register a page section definition.
   *
   * Idempotent: if section is already registered, skips and returns cleanup.
   * This supports React StrictMode which double-invokes effects.
   * @param definition - Page section definition to register
   * @returns Cleanup function to unregister the section
   */
  public register(definition: PageSectionDefinition): () => void {
    const key = this.makeKey(definition.parentPageId, definition.id);

    if (this.items.has(key)) {
      // Already registered - idempotent for StrictMode compatibility
      return () => undefined;
    }

    this.items.set(key, definition);
    this.invalidateCache();
    this.notify();

    // Capture the registered definition so a stale cleanup cannot remove a
    // newer registration that reused the same composite key later.
    return () => {
      if (this.items.get(key) === definition) {
        this.unregister(definition.parentPageId, definition.id);
      }
    };
  }

  /**
   * Get page section definition by parent page ID and section ID.
   * @param parentPageId - Parent page ID
   * @param sectionId - Section ID
   * @returns Section definition or undefined if not found
   */
  public get(parentPageId: string, sectionId: string): PageSectionDefinition | undefined {
    const key = this.makeKey(parentPageId, sectionId);
    return this.items.get(key);
  }

  /**
   * Get all sections for a parent page, sorted by order.
   * @param parentPageId - Parent page ID
   * @returns Array of section definitions sorted by order
   */
  public getByParent(parentPageId: string): PageSectionDefinition[] {
    if (!this.cachedByParent) {
      this.cachedByParent = new Map();
    }

    let cached = this.cachedByParent.get(parentPageId);
    if (!cached) {
      cached = Array.from(this.items.values())
        .filter((section) => section.parentPageId === parentPageId)
        .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
      this.cachedByParent.set(parentPageId, cached);
    }
    return cached;
  }

  /**
   * Get sections filtered by parent page and category.
   * @param parentPageId - Parent page ID
   * @param category - Category to filter by
   * @returns Array of matching section definitions, sorted by order
   */
  public getByParentAndCategory(parentPageId: string, category: string): PageSectionDefinition[] {
    return this.getByParent(parentPageId).filter((section) => section.category === category);
  }

  /**
   * Remove section from registry.
   * @param parentPageId - Parent page ID
   * @param sectionId - Section ID
   * @returns True if section was removed
   */
  public unregister(parentPageId: string, sectionId: string): boolean {
    const key = this.makeKey(parentPageId, sectionId);
    const result = this.items.delete(key);
    if (result) {
      this.invalidateCache();
      this.notify();
    }
    return result;
  }

  /**
   * Clear all sections.
   */
  public clear(): void {
    this.items.clear();
    this.invalidateCache();
    this.notify();
  }

  /**
   * Create composite key from parent page ID and section ID.
   * @param parentPageId - Parent page ID
   * @param sectionId - Section ID
   * @returns Composite key
   */
  private makeKey(parentPageId: string, sectionId: string): string {
    return `${parentPageId}:${sectionId}`;
  }

  /**
   * Invalidate internal caches.
   */
  private invalidateCache(): void {
    this.cachedByParent = null;
  }
}

/**
 * Global page section registry instance
 */
export const pageSectionRegistry = new PageSectionRegistry();
