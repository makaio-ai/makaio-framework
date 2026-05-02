import type { ReactNode } from 'react';
import styles from './Toggle.module.scss';

/**
 * Toggle size variants.
 *
 * - sm: 32x18px track
 * - md: 40x22px track
 */
export type ToggleSize = 'sm' | 'md';

/**
 * Base props for the Toggle switch component, excluding the accessible-name
 * constraint which is enforced via {@link ToggleProps}.
 */
interface BaseToggleProps {
  /** Whether the toggle is on. */
  checked: boolean;
  /**
   * Called when the toggle is clicked.
   * @param checked - The new checked state after the click.
   */
  onChange: (checked: boolean) => void;
  /** Whether the toggle is disabled. */
  disabled?: boolean;
  /** Toggle size variant. */
  size?: ToggleSize;
  /** Additional CSS class. */
  className?: string;
}

/**
 * Discriminated union that enforces at least one of `accessibleLabel` or
 * `ariaLabel` is supplied so the toggle always has an accessible name
 * (WCAG 2.1 SC 1.3.1 / 4.1.2).
 *
 * - `accessibleLabel` — the primary accessible name for the toggle. Not
 *   rendered as visible text; it is passed directly to `aria-label`. Use this
 *   when a visible label is provided by the surrounding UI or is otherwise
 *   unnecessary.
 * - `ariaLabel` — an override accessible name. When both `accessibleLabel` and
 *   `ariaLabel` are present, `ariaLabel` takes precedence.
 */
type AccessibleName = { accessibleLabel: string; ariaLabel?: string } | { accessibleLabel?: string; ariaLabel: string };

/**
 * Props for the Toggle switch component.
 *
 * At least one of `accessibleLabel` or `ariaLabel` must be provided so the
 * toggle always has an accessible name (WCAG 2.1 SC 1.3.1 / 4.1.2).
 */
export type ToggleProps = BaseToggleProps & AccessibleName;

/**
 * Toggle switch component.
 *
 * A pure presentational toggle switch rendered as an accessible `<button role="switch">`.
 * State is fully controlled via `checked` and `onChange` — no internal state.
 * Uses Aura theme tokens for all colors and sizing.
 * @param props - Component props
 * @returns Toggle switch component
 * @example
 * ```tsx
 * <Toggle checked={enabled} onChange={setEnabled} accessibleLabel="Enable notifications" />
 * <Toggle checked={active} onChange={setActive} size="sm" disabled ariaLabel="Toggle active" />
 * ```
 */
export function Toggle({
  checked,
  onChange,
  disabled = false,
  size = 'md',
  accessibleLabel,
  ariaLabel,
  className,
}: ToggleProps): ReactNode {
  const trackClass = [
    styles.track,
    styles[`size-${size}`],
    checked && styles.checked,
    disabled && styles.disabled,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  // An empty override should fall back to the visible/accessibility label
  // instead of suppressing the button's accessible name entirely.
  const normalizedAriaLabel = ariaLabel?.trim();
  const normalizedAccessibleLabel = accessibleLabel?.trim();
  const resolvedAriaLabel = normalizedAriaLabel || normalizedAccessibleLabel;
  if (!resolvedAriaLabel && process.env.NODE_ENV !== 'production') {
    console.warn('[Toggle] accessibleLabel/ariaLabel must not be empty.');
  }

  return (
    <button
      data-component="Toggle"
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={resolvedAriaLabel || undefined}
      disabled={disabled}
      className={trackClass}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.knob} aria-hidden="true" />
    </button>
  );
}
