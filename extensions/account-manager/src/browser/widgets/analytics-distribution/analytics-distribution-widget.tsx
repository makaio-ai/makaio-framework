/**
 * Analytics distribution widget.
 *
 * Stacked horizontal bar showing the share of total utilization observations
 * bucketed by `windowId` (e.g. `"5h"`, `"7d"`, `"7d-sonnet"`).
 *
 * **Distribution logic:** For each usage entry the `utilization` value is
 * summed per `windowId`. The sum across all windows becomes 100%. Each
 * segment's `flex-basis` is set to its percentage share so the bar is pure
 * flexbox — no SVG required.
 *
 * Percentages are rounded to one decimal place; rounding errors are absorbed
 * by the first (largest) segment so the total stays visually at 100%.
 * @packageDocumentation
 */

import { useMemo, type JSX } from 'react';
import { eraseWidgetConfig, type WidgetDefinition, type WidgetProps } from '@makaio/ui-kernel';
import type { UsageEntry } from '@makaio/extension-account-manager/schemas';
import { useAccountHistory } from '../../data/use-account-history.js';
import { useAnalyticsContext } from '../../pages/analytics/analytics-context.js';
import styles from './analytics-distribution-widget.module.scss';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of colour classes defined in SCSS (segment0–segment5). */
const MAX_SEGMENT_CLASSES = 6;

/**
 * Picks the Nth recurring SCSS class (e.g. `segment0`…`segment5`) from the
 * CSS-module styles bag. Keeps the segment bar and the legend swatches in
 * lockstep so their colour indices cannot drift.
 * @param prefix - Class-name prefix (`'segment'` or `'legendSwatch'`).
 * @param idx - Zero-based index; wraps around `MAX_SEGMENT_CLASSES`.
 * @returns The mapped class name from the CSS-module styles object.
 */
function pickSeriesClass(prefix: 'segment' | 'legendSwatch', idx: number): string {
  return styles[`${prefix}${idx % MAX_SEGMENT_CLASSES}` as keyof typeof styles];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single bucket in the distribution bar.
 */
interface DistributionBucket {
  /** `windowId` label. */
  id: string;
  /** Share of the total utilization sum (0–100). */
  pct: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute distribution buckets from raw usage entries.
 *
 * Sums `utilization` per `windowId`, then normalises to percentages.
 * Returns an empty result when there are no entries or when every entry's
 * utilization is zero — the distribution is derived from utilization share,
 * so there is no meaningful shape to show in that case.
 * @param entries - Raw usage entries from {@link useAccountHistory}.
 * @returns Buckets sorted descending by percentage share.
 */
function computeDistribution(entries: readonly UsageEntry[]): DistributionBucket[] {
  if (entries.length === 0) return [];

  const sumByWindow = new Map<string, number>();
  for (const entry of entries) {
    sumByWindow.set(entry.windowId, (sumByWindow.get(entry.windowId) ?? 0) + entry.utilization);
  }

  const total = Array.from(sumByWindow.values()).reduce((acc, v) => acc + v, 0);
  if (total === 0) return [];

  const buckets: DistributionBucket[] = Array.from(sumByWindow.entries())
    .map(([id, sum]) => ({ id, pct: Math.round((sum / total) * 1000) / 10 }))
    .sort((a, b) => b.pct - a.pct);

  // Absorb rounding errors into the first (largest) bucket.
  const sumPct = buckets.reduce((acc, b) => acc + b.pct, 0);
  const delta = Math.round((100 - sumPct) * 10) / 10;
  if (buckets.length > 0 && delta !== 0) {
    buckets[0] = { ...buckets[0], pct: Math.round((buckets[0].pct + delta) * 10) / 10 };
  }

  return buckets;
}

// ---------------------------------------------------------------------------
// Widget component
// ---------------------------------------------------------------------------

/** No per-instance configuration required. */
export type AnalyticsDistributionWidgetConfig = Record<string, never>;

/**
 * Analytics distribution widget component.
 * @param _props - Standard widget props (size and config unused).
 * @returns Distribution bar element.
 */
function AnalyticsDistributionWidget(_props: WidgetProps<AnalyticsDistributionWidgetConfig>): JSX.Element {
  const { clientId, accountId, from, to } = useAnalyticsContext();
  const { entries, loading, error } = useAccountHistory({ clientId, accountId }, { from, to });

  const buckets = useMemo(() => computeDistribution(entries), [entries]);

  return (
    <div className={styles.widget} data-component="AnalyticsDistributionWidget">
      <span className={styles.title}>Window Distribution</span>

      {loading ? (
        <span className={styles.empty} role="status" aria-live="polite">
          Loading data…
        </span>
      ) : error !== null ? (
        <span className={styles.empty} role="alert">
          Unable to load data for this period
        </span>
      ) : buckets.length === 0 ? (
        <span className={styles.empty}>No data for this period</span>
      ) : (
        <>
          {/* Stacked bar */}
          <div className={styles.barWrapper} role="img" aria-label="Utilization distribution by window">
            {buckets.map((bucket, idx) => (
              <div
                key={bucket.id}
                className={`${styles.barSegment} ${pickSeriesClass('segment', idx)}`}
                style={{ flexBasis: `${bucket.pct}%`, flexGrow: 0, flexShrink: 0 }}
                title={`${bucket.id}: ${bucket.pct}%`}
              />
            ))}
          </div>

          {/* Legend */}
          <div className={styles.legend}>
            {buckets.map((bucket, idx) => (
              <div key={bucket.id} className={styles.legendItem}>
                <div className={`${styles.legendSwatch} ${pickSeriesClass('legendSwatch', idx)}`} aria-hidden="true" />
                <span className={styles.legendLabel}>{bucket.id}</span>
                <span className={styles.legendPct}>{bucket.pct}%</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Widget definition
// ---------------------------------------------------------------------------

/**
 * Analytics distribution widget definition.
 *
 * Scope: `'account-manager:analytics'` — appears on the analytics page canvas.
 */
export const analyticsDistributionWidgetDefinition: WidgetDefinition<AnalyticsDistributionWidgetConfig> = {
  allowMultiple: false,
  component: AnalyticsDistributionWidget,
  defaultSize: 'medium',
  description: 'Stacked horizontal bar showing utilization share by window type.',
  id: 'account-manager:analytics-distribution',
  name: 'Window Distribution',
  scope: 'account-manager:analytics',
  supportedSizes: ['medium', 'large'],
};

/** Type-erased export for use in heterogeneous widget arrays. */
export const analyticsDistributionWidgetDefinitionErased = eraseWidgetConfig(analyticsDistributionWidgetDefinition);
