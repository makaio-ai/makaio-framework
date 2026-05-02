/**
 * Collapsible Component Types
 *
 * Shared types for CollapsibleSection and CollapsibleGroup components.
 */

import type { ReactNode } from 'react';

/**
 * Props for CollapsibleSection component.
 */
export interface CollapsibleSectionProps {
  /** Section title displayed in header */
  title: string;
  /** Controlled expanded state (omit for uncontrolled) */
  expanded?: boolean;
  /** Default expanded state for uncontrolled mode */
  defaultExpanded?: boolean;
  /** Callback when expanded state changes */
  onExpandedChange?: (expanded: boolean) => void;
  /** Optional action element rendered in the header (e.g., add button) */
  action?: ReactNode;
  /** Section content */
  children: ReactNode;
  /** Optional className for container */
  className?: string;
  /** Optional className for header */
  headerClassName?: string;
  /** Unique ID for group coordination (auto-generated if omitted) */
  id?: string;
}

/**
 * Group coordination mode.
 * - 'independent': Sections expand/collapse independently
 * - 'accordion': Only one section can be expanded at a time
 */
export type CollapsibleGroupMode = 'independent' | 'accordion';

/**
 * Props for CollapsibleGroup component.
 */
export interface CollapsibleGroupProps {
  /** Child CollapsibleSection components */
  children: ReactNode;
  /** Coordination mode */
  mode?: CollapsibleGroupMode;
  /** Key for localStorage persistence (omit to disable) */
  persistKey?: string;
  /** Optional className */
  className?: string;
}

/**
 * Context value provided by CollapsibleGroup.
 */
export interface CollapsibleContextValue {
  /** Current mode */
  mode: CollapsibleGroupMode;
  /** Map of section id -\> expanded state */
  expandedMap: Map<string, boolean>;
  /** Register a section with the group */
  register: (id: string, defaultExpanded: boolean) => void;
  /** Unregister a section */
  unregister: (id: string) => void;
  /** Toggle a section's expanded state */
  toggle: (id: string) => void;
  /** Expand all sections */
  expandAll: () => void;
  /** Collapse all sections */
  collapseAll: () => void;
}
