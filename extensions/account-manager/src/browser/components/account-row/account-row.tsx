/**
 * Account row component.
 *
 * Renders a single account entry with an active/inactive state marker, a
 * label, and an optional "Switch" button that appears on hover when
 * `onSwitch` is provided. Pure presentational component — no hooks, no bus.
 * @packageDocumentation
 */

import type { JSX } from 'react';
import { ACTIVE_INDICATOR, INACTIVE_INDICATOR } from '@makaio/extension-account-manager/utils';
import styles from './account-row.module.scss';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * Props for {@link AccountRow}.
 */
export interface AccountRowProps {
  /** Account display name or identifier. */
  label: string;
  /** Whether this account is currently active for its credential source. */
  active: boolean;
  /**
   * CSS color value for the activity marker dot.
   *
   * When omitted the marker inherits the semantic active/inactive colour
   * defined in the SCSS module via CSS custom properties.
   */
  markerColor?: string;
  /**
   * Callback invoked when the user clicks the "Switch" button.
   *
   * When absent, no switch affordance is rendered.
   */
  onSwitch?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Single account entry row.
 *
 * Renders a coloured marker, the account label, and an optional switch
 * action button that appears on row hover when `onSwitch` is provided.
 * @param props - Row configuration.
 * @returns A flex-layout row element.
 */
export function AccountRow({ label, active, markerColor, onSwitch }: AccountRowProps): JSX.Element {
  const rowClass = [styles.row, active ? styles.active : styles.inactive].join(' ');

  return (
    <div className={rowClass}>
      <span
        className={styles.marker}
        style={markerColor !== undefined ? { color: markerColor } : undefined}
        aria-hidden="true"
      >
        {active ? ACTIVE_INDICATOR : INACTIVE_INDICATOR}
      </span>
      <span className={styles.accountLabel}>{label}</span>
      {onSwitch !== undefined && (
        <button type="button" className={styles.switchButton} onClick={onSwitch} aria-label={`Switch to ${label}`}>
          Switch ↪
        </button>
      )}
    </div>
  );
}
