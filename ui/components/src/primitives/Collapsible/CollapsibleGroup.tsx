/**
 * CollapsibleGroup Component
 *
 * Container that coordinates multiple CollapsibleSection components.
 * Provides expandAll/collapseAll actions and optional accordion mode.
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { CollapsibleContext } from './CollapsibleContext.js';
import type { CollapsibleGroupProps, CollapsibleContextValue, CollapsibleGroupMode } from './types.js';

/**
 * Coordinates multiple CollapsibleSection components.
 * @param props - Component props
 * @example Independent mode (default)
 * ```tsx
 * <CollapsibleGroup>
 *   <CollapsibleSection title="Section 1">...</CollapsibleSection>
 *   <CollapsibleSection title="Section 2">...</CollapsibleSection>
 * </CollapsibleGroup>
 * ```
 * @example Accordion mode (only one open at a time)
 * ```tsx
 * <CollapsibleGroup mode="accordion">
 *   <CollapsibleSection title="Section 1">...</CollapsibleSection>
 *   <CollapsibleSection title="Section 2">...</CollapsibleSection>
 * </CollapsibleGroup>
 * ```
 */
export const CollapsibleGroup: React.FC<CollapsibleGroupProps> = ({
  children,
  mode = 'independent',
  persistKey,
  className,
}) => {
  // State: Map of section id -> expanded
  const [expandedMap, setExpandedMap] = useState<Map<string, boolean>>(() => {
    // Load from localStorage if persistKey provided
    if (persistKey && typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem(`collapsible:${persistKey}`);
        if (stored) {
          const parsed: unknown = JSON.parse(stored);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return new Map(
              Object.entries(parsed as Record<string, unknown>).filter(
                (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
              ),
            );
          }
        }
      } catch {
        // Ignore parse errors
      }
    }
    return new Map();
  });

  // Persist expandedMap to localStorage whenever it changes.
  // Persistence is driven by a useEffect rather than inside setExpandedMap
  // updaters — React Strict Mode invokes updaters twice in development, which
  // would cause duplicate writes and obscure storage errors if persistence
  // lived there. The effect-based approach also automatically catches all
  // mutations including register/unregister.
  useEffect(() => {
    if (!persistKey || typeof window === 'undefined') return;
    try {
      const obj = Object.fromEntries(expandedMap);
      localStorage.setItem(`collapsible:${persistKey}`, JSON.stringify(obj));
    } catch {
      // Ignore storage errors (e.g. private-browsing quota exceeded)
    }
  }, [expandedMap, persistKey]);

  /**
   * Register a section with the group, initialising its expanded state.
   * Accordion mode enforces the one-open invariant during registration.
   * @param id - Unique section identifier.
   * @param defaultExpanded - Whether the section should start expanded.
   */
  const register = useCallback(
    (id: string, defaultExpanded: boolean) => {
      setExpandedMap((prev) => {
        if (prev.has(id)) return prev;
        const next = new Map(prev);

        if (mode === 'accordion' && defaultExpanded) {
          // Accordion mode keeps the one-open invariant even when multiple
          // sections register with `defaultExpanded`.
          let hasExpandedSection = false;
          for (const expanded of next.values()) {
            if (expanded) {
              hasExpandedSection = true;
              break;
            }
          }
          next.set(id, !hasExpandedSection);
        } else {
          next.set(id, defaultExpanded);
        }

        return next;
      });
    },
    [mode],
  );

  /**
   * Remove a section from the group's expanded state map.
   * @param id - Unique section identifier to remove.
   */
  const unregister = useCallback((id: string) => {
    setExpandedMap((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  /**
   * Toggle the expanded state of a section.
   * In accordion mode, expanding a section collapses all others.
   * @param id - Unique section identifier to toggle.
   */
  const toggle = useCallback(
    (id: string) => {
      setExpandedMap((prev) => {
        const next = new Map(prev);
        const currentlyExpanded = prev.get(id) ?? false;

        if (mode === 'accordion' && !currentlyExpanded) {
          // In accordion mode, collapse all others when expanding
          for (const key of next.keys()) {
            next.set(key, key === id);
          }
        } else {
          next.set(id, !currentlyExpanded);
        }

        return next;
      });
    },
    [mode],
  );

  /**
   * Expand all registered sections.
   * In accordion mode, only the first registered section is expanded.
   */
  const expandAll = useCallback(() => {
    setExpandedMap((prev) => {
      const next = new Map(prev);

      if (mode === 'accordion') {
        let isFirst = true;
        for (const key of next.keys()) {
          next.set(key, isFirst);
          isFirst = false;
        }
        return next;
      }

      for (const key of next.keys()) {
        next.set(key, true);
      }
      return next;
    });
  }, [mode]);

  /** Collapse all registered sections regardless of mode. */
  const collapseAll = useCallback(() => {
    setExpandedMap((prev) => {
      const next = new Map(prev);
      for (const key of next.keys()) {
        next.set(key, false);
      }
      return next;
    });
  }, []);

  const contextValue = useMemo<CollapsibleContextValue>(
    () => ({
      mode: mode as CollapsibleGroupMode,
      expandedMap,
      register,
      unregister,
      toggle,
      expandAll,
      collapseAll,
    }),
    [mode, expandedMap, register, unregister, toggle, expandAll, collapseAll],
  );

  return (
    <CollapsibleContext.Provider value={contextValue}>
      <div data-component="CollapsibleGroup" className={className}>
        {children}
      </div>
    </CollapsibleContext.Provider>
  );
};
