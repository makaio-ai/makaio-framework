import type { ReactNode } from 'react';

/**
 * A single action item rendered in the context menu.
 */
export interface ContextMenuAction {
  /** Unique identifier for the action */
  id: string;
  /** Display label */
  label: string;
  /** Optional icon identifier (must match known icon set) */
  icon?: string;
  /** Category key for grouping */
  category: string;
  /** Optional keyboard shortcut display text */
  shortcut?: string;
}

/**
 * Category configuration for display ordering and labels.
 */
export interface CategoryConfig {
  /** Display label for the category group header */
  label: string;
  /** Sort order (lower = higher in menu) */
  order: number;
}

/**
 * Props for the generic ContextMenu component.
 */
export interface ContextMenuProps {
  /** Available actions to display */
  actions: ContextMenuAction[];
  /** Position to display the menu */
  position: { x: number; y: number };
  /** Callback when menu should close */
  onClose: () => void;
  /** Callback when an action is executed */
  onExecute: (actionId: string) => void;
  /** Category display config: maps category key to label + order */
  categoryConfig: Record<string, CategoryConfig>;
  /** ARIA label for the menu element */
  ariaLabel: string;
  /** Optional header content rendered above the action groups */
  header?: ReactNode;
}
