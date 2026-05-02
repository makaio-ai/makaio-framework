import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { Badge } from '../Badge/Badge.js';
import type { FilterOption } from './types.js';
import styles from './FilterChipGroup.module.scss';

/**
 * Props for FilterChipGroup component.
 * @typeParam T - The value type for filter options
 */
export interface FilterChipGroupProps<T> {
  /** Available filter options */
  options: FilterOption<T>[];
  /** Currently selected options (not just values) */
  selected: FilterOption<T>[];
  /** Called when selection changes */
  onChange: (selected: FilterOption<T>[]) => void;
  /** Allow multiple selections (default: true) */
  multiSelect?: boolean;
  /** Additional CSS class */
  className?: string;
}

/**
 * FilterChipGroup - Toggleable filter chips for list filtering.
 *
 * Pure component supporting single or multi-select modes.
 * @param options - Available filter options
 * @param selected - Currently selected options
 * @param onChange - Called when selection changes
 * @param multiSelect - Allow multiple selections (default: true)
 * @param className - Additional CSS class
 * @returns React component
 * @typeParam T - The value type for filter options
 */
export function FilterChipGroup<T>({
  options,
  selected,
  onChange,
  multiSelect = true,
  className,
}: FilterChipGroupProps<T>): ReactNode {
  const selectedIds = new Set(selected.map((item) => item.id));
  // Deduplicate stale entries before deriving the selected state so a
  // duplicate cannot masquerade as "all selected".
  const allSelected = options.length > 0 && options.every((option) => selectedIds.has(option.id));

  /**
   * handleToggle - Toggle selection for a single filter option.
   * @param option - The FilterOption<T> to toggle.
   * @returns void
   */
  const handleToggle = (option: FilterOption<T>) => {
    const isSelected = selectedIds.has(option.id);

    if (multiSelect) {
      if (isSelected) {
        onChange(options.filter((o) => selectedIds.has(o.id) && o.id !== option.id));
      } else {
        onChange(options.filter((o) => selectedIds.has(o.id) || o.id === option.id));
      }
    } else {
      onChange(isSelected ? [] : [option]);
    }
  };

  /**
   * handleSelectAll - Select or clear all filter options.
   * @returns void
   */
  const handleSelectAll = () => {
    if (allSelected) {
      onChange([]);
    } else {
      onChange(options);
    }
  };

  return (
    <div data-component="FilterChipGroup" className={clsx(styles.chipGroup, className)}>
      {multiSelect && options.length > 2 && (
        <button
          type="button"
          className={clsx(styles.chip, allSelected && styles.selected)}
          onClick={handleSelectAll}
          aria-pressed={allSelected}
        >
          <Badge variant="default" size="sm">
            All
          </Badge>
        </button>
      )}
      {options.map((option) => {
        const isSelected = selectedIds.has(option.id);
        return (
          <button
            key={option.id}
            type="button"
            className={clsx(styles.chip, isSelected && styles.selected)}
            onClick={() => handleToggle(option)}
            aria-pressed={isSelected}
          >
            <Badge variant={isSelected ? (option.variant ?? 'primary') : 'default'} size="sm">
              {option.label}
              {option.count !== undefined && ` (${option.count})`}
            </Badge>
          </button>
        );
      })}
    </div>
  );
}
