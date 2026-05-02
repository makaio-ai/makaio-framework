import { useId } from 'react';
import { clsx } from 'clsx';
import styles from './ButtonGroupFilter.module.scss';

/**
 * Represents a single option in the button group filter.
 * Generic type parameter T is the string literal type for option values.
 */
export interface ButtonGroupOption<T extends string> {
  /** The value of this option */
  value: T;
  /** The label to display for this option */
  label: string;
  /** Whether this option is disabled */
  disabled?: boolean;
}

/**
 * Props for the ButtonGroupFilter component.
 * Generic type parameter T is the string literal type for option values.
 */
export interface ButtonGroupFilterProps<T extends string> {
  /** Current selected value */
  value: T;
  /** Callback when the selected value changes */
  onChange: (value: T) => void;
  /** Array of options to display */
  options: ButtonGroupOption<T>[];
  /** Optional counts to display in parentheses after each label */
  counts?: Partial<Record<T, number>>;
  /** Label text shown before the buttons */
  label?: string;
  /** Optional CSS class name for the container */
  className?: string;
}

/**
 * ButtonGroupFilter - Generic toggle control for filtering with button groups.
 * Provides a reusable component for creating filter controls with multiple options.
 * Generic type parameter T is the string literal type for option values.
 * @param props - Component props
 * @returns Button group filter control
 * @example
 * ```tsx
 * const options = [
 *   { value: 'all', label: 'All' },
 *   { value: 'active', label: 'Active' },
 *   { value: 'closed', label: 'Closed' },
 * ];
 *
 * <ButtonGroupFilter
 *   value={status}
 *   onChange={setStatus}
 *   options={options}
 *   counts={{ all: 10, active: 5, closed: 5 }}
 *   label="Status"
 * />
 * ```
 */
export function ButtonGroupFilter<T extends string>({
  value,
  onChange,
  options,
  counts,
  label,
  className,
}: ButtonGroupFilterProps<T>) {
  const labelId = useId();

  /**
   * Format button label with optional count.
   * @param option - The option to format
   * @returns Formatted label string
   */
  const formatLabel = (option: ButtonGroupOption<T>): string => {
    if (!counts) return option.label;
    const count = counts[option.value];
    return count !== undefined ? `${option.label} (${count})` : option.label;
  };

  return (
    <div
      data-component="ButtonGroupFilter"
      className={clsx(styles.buttonGroupFilter, className)}
      role="group"
      aria-labelledby={label ? labelId : undefined}
    >
      {label && (
        <span id={labelId} className={styles.label}>
          {label}:
        </span>
      )}
      <div className={styles.buttons}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={value === option.value ? styles.buttonActive : styles.button}
            onClick={() => onChange(option.value)}
            disabled={option.disabled}
            aria-pressed={value === option.value}
          >
            {formatLabel(option)}
          </button>
        ))}
      </div>
    </div>
  );
}
