/**
 * Web usage gauge component.
 *
 * Renders a horizontal utilization bar with a label, percentage, and optional
 * reset countdown. Pure presentational component — no hooks, no bus access.
 * All colours derive from CSS custom properties defined in the companion
 * SCSS module using `@makaio/web-theme` tokens.
 * @packageDocumentation
 */

import type { JSX } from 'react';
import styles from './usage-gauge.module.scss';
import { clampUtilization, deriveGaugeState } from '@makaio/extension-account-manager/utils';
import type { GaugeState } from '@makaio/extension-account-manager/utils';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * Props for {@link UsageGauge}.
 */
export interface UsageGaugeProps {
  /** Human-readable label rendered to the left of the gauge bar. */
  label: string;
  /**
   * Current utilization as a fraction in the range 0–1.
   *
   * Values outside this range are clamped. The gauge renders 0% for
   * non-finite values.
   */
  percentage: number;
  /**
   * Optional human-readable reset countdown string, e.g. `"2h 14m"`.
   * Rendered below the gauge bar when provided.
   */
  resetCountdown?: string;
  /**
   * Override the automatic semantic state derived from {@link percentage}.
   *
   * Use this when the caller knows the account is blocked or otherwise
   * wishes to force a specific colour tier independently of the utilization
   * value.
   */
  state?: GaugeState;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Compact usage gauge bar.
 *
 * Renders a CSS-based percentage fill bar whose colour reflects the
 * utilization tier. Pure component — no side effects.
 * @param props - Gauge configuration.
 * @returns A flex-layout gauge element.
 */
export function UsageGauge({ label, percentage, resetCountdown, state }: UsageGaugeProps): JSX.Element {
  const clamped = clampUtilization(percentage);

  const gaugeState = state ?? deriveGaugeState(clamped);
  const pct = Math.round(clamped * 100);

  return (
    <div className={styles.gauge}>
      <div className={styles.header}>
        <span className={styles.label}>{label}</span>
        <span className={styles.percentage}>{`${pct}%`}</span>
      </div>
      <div
        className={`${styles.track} ${styles[gaugeState]}`}
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className={styles.fill} style={{ width: `${pct}%` }} />
      </div>
      {resetCountdown !== undefined && <div className={styles.countdown}>{`resets in ${resetCountdown}`}</div>}
    </div>
  );
}
