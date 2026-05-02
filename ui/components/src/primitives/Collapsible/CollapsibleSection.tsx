/**
 * CollapsibleSection Component
 *
 * A collapsible panel with animated expand/collapse.
 * Supports both controlled and uncontrolled modes.
 * Can be used standalone or within a CollapsibleGroup.
 */

import React, { useState, useId, useEffect } from 'react';
import { clsx } from 'clsx';
import { ChevronDown } from 'lucide-react';
import type { CollapsibleSectionProps } from './types.js';
import { useCollapsibleGroup } from './CollapsibleContext.js';
import styles from './CollapsibleSection.module.scss';

/**
 * Collapsible section with smooth height animation.
 * @param props - Component props
 * @example Uncontrolled (internal state)
 * ```tsx
 * <CollapsibleSection title="Settings" defaultExpanded>
 *   <SettingsPanel />
 * </CollapsibleSection>
 * ```
 * @example Controlled (external state)
 * ```tsx
 * <CollapsibleSection
 *   title="Branches"
 *   expanded={isExpanded}
 *   onExpandedChange={setIsExpanded}
 * >
 *   <BranchList />
 * </CollapsibleSection>
 * ```
 */
export const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title,
  expanded: controlledExpanded,
  defaultExpanded = true,
  onExpandedChange,
  action,
  children,
  className,
  headerClassName,
  id: providedId,
}) => {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const group = useCollapsibleGroup();

  // Determine if controlled externally, by group, or internally
  const isControlled = controlledExpanded !== undefined;
  const isGrouped = group !== null && !isControlled;

  // Internal state for uncontrolled mode
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);

  // Register with the group whenever this section is grouped.
  // Depends on stable `register`/`unregister` useCallbacks from
  // CollapsibleGroup rather than the whole `group` object, which changes
  // identity every time `expandedMap` updates (because contextValue is
  // recreated by useMemo). Using the whole `group` object as a dep would
  // cause the effect to re-run on every sibling toggle, unregistering and
  // re-registering this section and resetting its expansion state.
  useEffect(() => {
    if (!isGrouped || group === null) return;
    group.register(id, defaultExpanded);
    return () => {
      group.unregister(id);
    };
  }, [id, isGrouped, defaultExpanded, group?.register, group?.unregister]);

  // Resolve current expanded state
  let isExpanded: boolean;
  if (isControlled) {
    isExpanded = controlledExpanded;
  } else if (isGrouped) {
    isExpanded = group.expandedMap.get(id) ?? defaultExpanded;
  } else {
    isExpanded = internalExpanded;
  }

  const handleToggle = () => {
    if (isControlled) {
      onExpandedChange?.(!controlledExpanded);
    } else if (isGrouped) {
      group.toggle(id);
    } else {
      const newValue = !internalExpanded;
      setInternalExpanded(newValue);
      onExpandedChange?.(newValue);
    }
  };

  return (
    <div data-component="CollapsibleSection" className={clsx(styles.section, className)}>
      <div className={clsx(styles.header, headerClassName)}>
        <button
          id={`${id}-trigger`}
          type="button"
          className={styles.headerToggle}
          onClick={handleToggle}
          aria-expanded={isExpanded}
          aria-controls={`${id}-content`}
        >
          <span className={styles.title}>{title}</span>
          <span className={clsx(styles.chevron, !isExpanded && styles.collapsed)}>
            <ChevronDown />
          </span>
        </button>
        {action && <span className={styles.headerAction}>{action}</span>}
      </div>
      <div
        id={`${id}-content`}
        role="region"
        aria-labelledby={`${id}-trigger`}
        className={clsx(styles.content, isExpanded && styles.expanded)}
        inert={!isExpanded ? true : undefined}
      >
        <div className={styles.contentInner}>{children}</div>
      </div>
    </div>
  );
};
