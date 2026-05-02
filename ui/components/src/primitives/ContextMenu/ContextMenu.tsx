/**
 * ContextMenu - Generic context menu component
 *
 * Renders a glassmorphism context menu with actions grouped by category.
 * Provides click-outside and Escape key dismissal, keyboard shortcut display,
 * and category grouping with separators.
 *
 * Used as the shared implementation for all domain-specific context menus
 * (commit, file, branch, etc.).
 *
 * Note: `role="menu"` / `role="menuitem"` are intentionally omitted. The ARIA
 * menu pattern requires full arrow-key focus management; without it, assistive
 * technology will announce an inaccessible menu that users cannot navigate by
 * keyboard. Plain list semantics (`<ul>`/`<li>`) with focusable `<button>`
 * children are correct and honest here. Remove this note and restore menu roles
 * when a keyboard-navigation focus manager is added.
 * @example
 * ```tsx
 * <ContextMenu
 *   actions={actions}
 *   position={{ x: 100, y: 200 }}
 *   onClose={() => setVisible(false)}
 *   onExecute={(actionId) => handleAction(actionId)}
 *   categoryConfig={{ view: { label: 'View', order: 0 } }}
 *   ariaLabel="Commit actions"
 *   header={<code>abc123d</code>}
 * />
 * ```
 */

import { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Icon, isIconName } from '../Icon/index.js';
import type { ContextMenuProps, ContextMenuAction } from './ContextMenu.types.js';
import styles from './ContextMenu.module.scss';

/**
 * Groups actions by their category key.
 * @param actions - Actions to group
 * @returns Map of category key to actions
 */
function groupByCategory(actions: ContextMenuAction[]): Map<string, ContextMenuAction[]> {
  const groups = new Map<string, ContextMenuAction[]>();

  for (const action of actions) {
    let existing = groups.get(action.category);
    if (!existing) {
      existing = [];
      groups.set(action.category, existing);
    }
    existing.push(action);
  }

  return groups;
}

/**
 * Sorts category entries by their configured order.
 * @param entries - Category entries to sort
 * @param config - Category configuration for ordering
 * @returns Sorted entries
 */
function sortCategories(
  entries: [string, ContextMenuAction[]][],
  config: Record<string, { label: string; order: number }>,
): [string, ContextMenuAction[]][] {
  return entries.sort(([a], [b]) => {
    const orderA = config[a]?.order ?? Number.MAX_SAFE_INTEGER;
    const orderB = config[b]?.order ?? Number.MAX_SAFE_INTEGER;
    return orderA - orderB;
  });
}

/**
 * Generic context menu component.
 *
 * Displays actions grouped by category with keyboard shortcuts.
 * Closes on click outside or Escape key.
 * Features glass panel effect with backdrop blur.
 * @param props - Component props
 */
export function ContextMenu(props: ContextMenuProps) {
  const { actions, position, onClose, onExecute, categoryConfig, ariaLabel, header } = props;

  const menuRef = useRef<HTMLDivElement>(null);

  const handleAction = useCallback(
    (actionId: string) => {
      try {
        onExecute(actionId);
      } finally {
        onClose();
      }
    },
    [onExecute, onClose],
  );

  // Handle click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    // Use capture phase to catch clicks before they bubble
    document.addEventListener('click', handleClickOutside, true);
    return () => document.removeEventListener('click', handleClickOutside, true);
  }, [onClose]);

  // Handle Escape key
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Guard against non-DOM environments (SSR / test environments without a
  // document body). createPortal throws when document.body is absent.
  if (typeof document === 'undefined' || !document.body) {
    return null;
  }

  const groupedActions = groupByCategory(actions);
  const sortedCategories = sortCategories(Array.from(groupedActions.entries()), categoryConfig);

  // Portal to document.body so position: fixed escapes ancestor
  // backdrop-filter / transform containing blocks (e.g., PaneContainer glass panels).
  return createPortal(
    <div
      data-component="ContextMenu"
      ref={menuRef}
      className={styles.contextMenu}
      style={{ left: position.x, top: position.y }}
      aria-label={ariaLabel}
    >
      {/* Optional header */}
      {header != null && <div className={styles.header}>{header}</div>}

      {/* Actions or empty state */}
      {actions.length === 0 ? (
        <div className={styles.emptyState}>No actions available</div>
      ) : (
        <ul className={styles.actionGroups}>
          {sortedCategories.map(([category, categoryActions]) => (
            <li key={category} className={styles.group}>
              <div className={styles.groupLabel}>{categoryConfig[category]?.label ?? category}</div>
              <ul>
                {categoryActions.map((action) => (
                  <li key={action.id}>
                    <button type="button" className={styles.actionItem} onClick={() => handleAction(action.id)}>
                      {renderIcon(action.icon)}
                      <span className={styles.label}>{action.label}</span>
                      {action.shortcut && <span className={styles.shortcut}>{action.shortcut}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>,
    document.body,
  );
}

/**
 * Render a menu icon if it matches the known icon set.
 * @param icon - Icon name from action
 * @returns Icon element or null
 */
function renderIcon(icon: string | undefined) {
  if (!icon || !isIconName(icon)) return null;
  return (
    <span className={styles.icon}>
      <Icon name={icon} />
    </span>
  );
}
