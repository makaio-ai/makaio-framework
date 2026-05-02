/**
 * Analytics heatmap widget.
 *
 * Renders a 7 × 24 day-of-week / hour-of-day heatmap grid that shows usage
 * intensity aggregated from {@link useAccountHistory}.
 *
 * **Aggregation:** Each {@link UsageEntry} is placed in the cell matching its
 * timestamp's UTC day-of-week (`getUTCDay()`, 0 = Sunday) and UTC hour
 * (`getUTCHours()`, 0–23). The heatmap aggregates entries across the entire
 * query window, so a given `(day, hour)` cell shows the maximum utilization
 * observed in that bucket.
 *
 * **Intensity tiers:**
 * - 0: no observation.
 * - 1: utilization in [0, 25].
 * - 2: utilization in (25, 50].
 * - 3: utilization in (50, 75].
 * - 4: utilization above 75.
 * @packageDocumentation
 */

import { useMemo, type JSX } from 'react';
import { eraseWidgetConfig, type WidgetDefinition, type WidgetProps } from '@makaio/ui-kernel';
import type { UsageEntry } from '@makaio-community/account-manager/schemas';
import { useAccountHistory } from '../../data/use-account-history.js';
import { useAnalyticsContext } from '../../pages/analytics/analytics-context.js';
import styles from './analytics-heatmap-widget.module.scss';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of UTC days in a week (heatmap rows). */
const DAYS_PER_WEEK = 7;

/** Number of hours in a UTC day (heatmap columns). */
const HOURS_PER_DAY = 24;

/** Total number of heatmap buckets. */
const BUCKET_COUNT = DAYS_PER_WEEK * HOURS_PER_DAY;

/** Day-of-week labels (UTC Sunday-first). */
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Hour axis labels shown every 6 hours. */
const HOUR_AXIS_LABELS = Array.from({ length: HOURS_PER_DAY }, (_, h) => (h % 6 === 0 ? `${h}h` : ''));

/** Number of intensity tiers (0 = empty, 1–4 = heat levels). */
const TIER_COUNT = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a max-utilization value to a display intensity tier.
 *
 * Tier 0 is reserved for "no data" (called separately).
 * @param maxUtilization - Maximum utilization (0–100) observed in this bucket.
 * @returns Intensity tier in the range 1–4.
 */
function utilizationToTier(maxUtilization: number): 1 | 2 | 3 | 4 {
  if (maxUtilization > 75) return 4;
  if (maxUtilization > 50) return 3;
  if (maxUtilization > 25) return 2;
  return 1;
}

/**
 * Build a 7 × 24 matrix of intensity tiers from raw usage entries.
 *
 * Bucketing uses UTC day-of-week and UTC hour so the grid is timezone-agnostic.
 * @param entries - Raw usage entries from {@link useAccountHistory}.
 * @returns Flat array of length 168 (7 days × 24 hours) with tier values 0–4.
 */
function buildHeatmapMatrix(entries: readonly UsageEntry[]): Array<0 | 1 | 2 | 3 | 4> {
  // DAYS_PER_WEEK × HOURS_PER_DAY buckets; max utilization per bucket.
  const maxByBucket = new Float32Array(BUCKET_COUNT).fill(-1);

  for (const entry of entries) {
    const date = new Date(entry.ts);
    // Skip malformed entries so one bad row can't produce NaN buckets.
    if (!Number.isFinite(date.getTime()) || !Number.isFinite(entry.utilization)) {
      continue;
    }
    const day = date.getUTCDay(); // 0 (Sun) – 6 (Sat)
    const hour = date.getUTCHours(); // 0–23
    const idx = day * HOURS_PER_DAY + hour;
    if (entry.utilization > maxByBucket[idx]) {
      maxByBucket[idx] = entry.utilization;
    }
  }

  return Array.from({ length: BUCKET_COUNT }, (_, i) => {
    const max = maxByBucket[i];
    if (max < 0) return 0; // no data
    return utilizationToTier(max);
  });
}

// ---------------------------------------------------------------------------
// Widget component
// ---------------------------------------------------------------------------

/** No per-instance configuration required. */
export type AnalyticsHeatmapWidgetConfig = Record<string, never>;

/**
 * Analytics heatmap widget component.
 * @param _props - Standard widget props (size and config unused).
 * @returns Heatmap grid element.
 */
function AnalyticsHeatmapWidget(_props: WidgetProps<AnalyticsHeatmapWidgetConfig>): JSX.Element {
  const { clientId, accountId, from, to } = useAnalyticsContext();
  const { entries, loading, error } = useAccountHistory({ clientId, accountId }, { from, to });

  const matrix = useMemo(() => buildHeatmapMatrix(entries), [entries]);

  return (
    <div className={styles.widget} data-component="AnalyticsHeatmapWidget">
      <span className={styles.title}>Usage Heatmap (UTC)</span>

      {loading && (
        <span className={styles.statusLine} role="status" aria-live="polite">
          Loading data…
        </span>
      )}
      {!loading && error !== null && (
        <span className={styles.statusLine} role="alert">
          Unable to load data for this period
        </span>
      )}

      {/* Hour axis labels */}
      <div className={styles.axisRow} aria-hidden="true">
        <span />
        {HOUR_AXIS_LABELS.map((label, h) => (
          <span key={h} className={styles.axisLabel}>
            {label}
          </span>
        ))}
      </div>

      {/* Day rows */}
      <div className={styles.gridWrapper} role="table" aria-label="Usage heatmap">
        {DAY_LABELS.map((day, dayIndex) => (
          <div key={day} className={styles.gridRow} role="row">
            <span className={styles.dayLabel} role="rowheader">
              {day}
            </span>
            {Array.from({ length: HOURS_PER_DAY }, (_, hour) => {
              const tier = matrix[dayIndex * HOURS_PER_DAY + hour] ?? 0;
              return (
                <div
                  key={hour}
                  role="cell"
                  className={styles.cell}
                  data-day-index={dayIndex}
                  data-hour={hour}
                  data-intensity={tier}
                  aria-label={`${day} ${hour}:00 — intensity ${tier}`}
                />
              );
            })}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className={styles.legend} aria-label="Intensity legend">
        <span className={styles.legendLabel}>Less</span>
        <div className={styles.legendSwatch}>
          {/* Legend swatches use the same `data-intensity` contract as grid cells. */}
          {Array.from({ length: TIER_COUNT }, (_, i) => (
            <div key={i} className={styles.legendCell} data-intensity={i} />
          ))}
        </div>
        <span className={styles.legendLabel}>More</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Widget definition
// ---------------------------------------------------------------------------

/**
 * Analytics heatmap widget definition.
 *
 * Scope: `'account-manager:analytics'` — appears on the analytics page canvas.
 */
export const analyticsHeatmapWidgetDefinition: WidgetDefinition<AnalyticsHeatmapWidgetConfig> = {
  allowMultiple: false,
  component: AnalyticsHeatmapWidget,
  defaultSize: 'large',
  description: '7×24 day-hour heatmap of usage intensity (UTC buckets).',
  id: 'account-manager:analytics-heatmap',
  name: 'Usage Heatmap',
  scope: 'account-manager:analytics',
  supportedSizes: ['large', 'full-width'],
};

/** Type-erased export for use in heterogeneous widget arrays. */
export const analyticsHeatmapWidgetDefinitionErased = eraseWidgetConfig(analyticsHeatmapWidgetDefinition);
