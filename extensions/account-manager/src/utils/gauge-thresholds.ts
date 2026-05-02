/** Usage fraction at or above which the gauge is in warning state. */
export const GAUGE_WARNING_THRESHOLD = 0.7;

/** Usage fraction at or above which the gauge is in critical state. */
export const GAUGE_CRITICAL_THRESHOLD = 0.9;

/**
 * Semantic gauge states derived from utilization fractions in [0, 1].
 *
 * - `'normal'` — utilization is below the warning threshold.
 * - `'warning'` — utilization is elevated (≥ 70%).
 * - `'critical'` — utilization is near or at the limit (≥ 90%).
 */
export type GaugeState = 'normal' | 'warning' | 'critical';

/**
 * Clamp a possibly-invalid utilization value to the [0, 1] range.
 * Non-finite values (NaN, Infinity) are treated as 0.
 * @param raw - Raw utilization value
 * @returns Clamped value in [0, 1]
 */
export function clampUtilization(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.min(1, Math.max(0, raw));
}

/**
 * Derive the semantic gauge state from a utilization value.
 * @param utilization - Utilization as a fraction in [0, 1]. Values outside this range are clamped.
 * @returns Semantic state: 'critical' when \>= 90%, 'warning' when \>= 70%, else 'normal'.
 */
export function deriveGaugeState(utilization: number): GaugeState {
  const clamped = clampUtilization(utilization);
  if (clamped >= GAUGE_CRITICAL_THRESHOLD) return 'critical';
  if (clamped >= GAUGE_WARNING_THRESHOLD) return 'warning';
  return 'normal';
}
