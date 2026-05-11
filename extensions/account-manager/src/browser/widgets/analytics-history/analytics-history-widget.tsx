/**
 * Analytics history widget.
 *
 * Multi-series time-series line chart showing utilization per `windowId` over
 * the selected range. Uses `d3-shape` `line()` for path generation and a
 * hand-rolled linear scale (domain → range math) to avoid pulling in
 * `d3-scale` or `d3-axis`.
 *
 * **Scale math:**
 * - X axis: `x = (ts - from) / (to - from) * WIDTH`
 * - Y axis: `y = HEIGHT - (utilization / 100) * HEIGHT`
 *
 * Both axes have 5% padding applied to the SVG `viewBox` to prevent clipping.
 *
 * **Series colours:** Assigned by index via CSS class (`series0`, `series1`, …)
 * so the SVG path element does not carry inline styles and Aura tokens apply
 * naturally.
 *
 * **Tooltip:** A single shared tooltip is positioned via local React state.
 * It appears on SVG `onMouseMove` and disappears on `onMouseLeave`.
 * @packageDocumentation
 */

import { useMemo, useState, useCallback, useEffect, type JSX, type MouseEvent } from 'react';
import { line } from 'd3-shape';
import { eraseWidgetConfig, type WidgetDefinition, type WidgetProps } from '@makaio/ui-kernel';
import type { UsageEntry } from '@makaio/extension-account-manager/schemas';
import { useAccountHistory } from '../../data/use-account-history.js';
import { useAnalyticsContext } from '../../pages/analytics/analytics-context.js';
import styles from './analytics-history-widget.module.scss';

// ---------------------------------------------------------------------------
// Chart constants
// ---------------------------------------------------------------------------

/** SVG viewBox logical dimensions. */
const VIEW_W = 600;
const VIEW_H = 200;

/** Padding fraction applied uniformly to avoid clipping at bounds. */
const PADDING_FRAC = 0.05;

/** Number of horizontal grid / Y-axis ticks. */
const Y_TICK_COUNT = 5;

/** Number of vertical grid / X-axis ticks. */
const X_TICK_COUNT = 5;

/** Maximum number of series classes defined in SCSS (series0–series5). */
const MAX_SERIES_CLASSES = 6;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Single data point in a chart series.
 */
interface ChartPoint {
  /** Epoch ms timestamp. */
  ts: number;
  /** Utilization percentage 0–100. */
  utilization: number;
}

/**
 * A named time-series.
 */
interface ChartSeries {
  /** `windowId` value used as the series label. */
  id: string;
  /** Ordered data points (ascending by ts). */
  points: ChartPoint[];
}

/**
 * Shared tooltip state.
 */
interface TooltipState {
  /** X position in CSS pixels relative to the SVG wrapper. */
  x: number;
  /** Y position in CSS pixels relative to the SVG wrapper. */
  y: number;
  /** Label to display. */
  label: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build one {@link ChartSeries} per unique `windowId` from raw usage entries.
 *
 * Points are sorted ascending by `ts`.
 * @param entries - Raw usage entries from {@link useAccountHistory}.
 * @returns Chart series, one per unique `windowId`.
 */
function buildSeries(entries: readonly UsageEntry[]): ChartSeries[] {
  const seriesMap = new Map<string, ChartPoint[]>();

  for (const entry of entries) {
    let pts = seriesMap.get(entry.windowId);
    if (!pts) {
      pts = [];
      seriesMap.set(entry.windowId, pts);
    }
    pts.push({ ts: entry.ts, utilization: entry.utilization });
  }

  return Array.from(seriesMap.entries())
    .map(([id, points]) => ({
      id,
      // Sort locally so chart rendering stays stable even if upstream fetch
      // order changes or cached data is hydrated from a different source.
      points: [...points].sort((a, b) => a.ts - b.ts),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Map a domain value linearly to a range value.
 *
 * Equivalent to `d3.scaleLinear().domain([dMin, dMax]).range([rMin, rMax])`.
 * @param value - Input value in domain.
 * @param dMin - Domain minimum.
 * @param dMax - Domain maximum.
 * @param rMin - Range minimum (output).
 * @param rMax - Range maximum (output).
 * @returns Scaled output value; clamped to range when domain span is zero.
 */
function linearScale(value: number, dMin: number, dMax: number, rMin: number, rMax: number): number {
  const span = dMax - dMin;
  if (span === 0) return (rMin + rMax) / 2;
  return rMin + ((value - dMin) / span) * (rMax - rMin);
}

// ---------------------------------------------------------------------------
// Chart component
// ---------------------------------------------------------------------------

/**
 * Props for the inner SVG chart.
 */
interface ChartProps {
  /** All series to draw. */
  series: ChartSeries[];
  /** Range start (epoch ms). */
  from: number;
  /** Range end (epoch ms). */
  to: number;
  /** Tooltip state setter. */
  onTooltip: (state: TooltipState | null) => void;
}

/**
 * Renders the multi-series SVG line chart.
 * @param props - Chart rendering configuration.
 * @returns SVG element.
 */
function Chart({ series, from, to, onTooltip }: ChartProps): JSX.Element {
  // Logical chart area with padding applied to viewBox coordinates.
  const padX = VIEW_W * PADDING_FRAC;
  const padY = VIEW_H * PADDING_FRAC;
  const chartLeft = padX;
  const chartRight = VIEW_W - padX;
  const chartTop = padY;
  const chartBottom = VIEW_H - padY;

  /**
   * Map epoch ms to an SVG X coordinate.
   * @param ts - Epoch ms timestamp.
   * @returns SVG x value.
   */
  const xScale = useCallback(
    (ts: number): number => linearScale(ts, from, to, chartLeft, chartRight),
    [from, to, chartLeft, chartRight],
  );

  /**
   * Map utilization (0–100) to an SVG Y coordinate (inverted: 0 at bottom).
   * @param utilization - Utilization percentage.
   * @returns SVG y value.
   */
  const yScale = useCallback(
    (utilization: number): number => linearScale(utilization, 0, 100, chartBottom, chartTop),
    [chartTop, chartBottom],
  );

  // Build d3-shape path generator.
  const lineGenerator = useMemo(
    () =>
      line<ChartPoint>()
        .x((d) => xScale(d.ts))
        .y((d) => yScale(d.utilization)),
    [xScale, yScale],
  );

  // Y-axis grid lines + ticks (0, 25, 50, 75, 100).
  const yTicks = Array.from({ length: Y_TICK_COUNT }, (_, i) => (i * 100) / (Y_TICK_COUNT - 1));

  // X-axis ticks (evenly spaced across the range).
  const xTicks = Array.from({ length: X_TICK_COUNT }, (_, i) => {
    const fraction = i / (X_TICK_COUNT - 1);
    return from + fraction * (to - from);
  });

  /**
   * Find the nearest data point across all series for a pointer event.
   * @param e - Mouse event on the SVG element.
   */
  const handleMouseMove = useCallback(
    (e: MouseEvent<SVGSVGElement>): void => {
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        onTooltip(null);
        return;
      }
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;

      // Map pointer to logical SVG space for chart-space distance.
      const svgX = (px / rect.width) * VIEW_W;
      const svgY = (py / rect.height) * VIEW_H;

      // Find the visually nearest point across all series in chart space so
      // that when two series share a timestamp the tooltip picks the series
      // whose line the cursor is actually hovering over.
      let closest: ChartPoint | null = null;
      let closestSeriesId = '';
      let minDistSq = Infinity;

      for (const s of series) {
        for (const pt of s.points) {
          const dx = xScale(pt.ts) - svgX;
          const dy = yScale(pt.utilization) - svgY;
          const distSq = dx * dx + dy * dy;
          if (distSq < minDistSq) {
            minDistSq = distSq;
            closest = pt;
            closestSeriesId = s.id;
          }
        }
      }

      if (closest) {
        const label = `${closestSeriesId}: ${closest.utilization.toFixed(1)}%`;
        onTooltip({ x: px, y: py - 8, label });
      }
    },
    [series, xScale, yScale, onTooltip],
  );

  const handleMouseLeave = useCallback((): void => {
    onTooltip(null);
  }, [onTooltip]);

  return (
    <svg
      className={styles.svg}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMid meet"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      aria-label="Usage history line chart"
    >
      {/* Horizontal grid lines */}
      {yTicks.map((u) => {
        const y = yScale(u);
        return (
          <g key={u}>
            <line className={styles.gridLine} x1={chartLeft} y1={y} x2={chartRight} y2={y} />
            <text className={styles.axisTick} x={chartLeft - 4} y={y + 3} textAnchor="end">
              {u}%
            </text>
          </g>
        );
      })}

      {/* Vertical grid lines */}
      {xTicks.map((ts, i) => {
        const x = xScale(ts);
        const label = new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        return (
          <g key={i}>
            <line className={styles.gridLine} x1={x} y1={chartTop} x2={x} y2={chartBottom} />
            <text className={styles.axisTick} x={x} y={chartBottom + 14} textAnchor="middle">
              {label}
            </text>
          </g>
        );
      })}

      {/* Series paths */}
      {series.map((s, idx) => {
        if (s.points.length === 0) return null;
        const d = lineGenerator(s.points);
        if (!d) return null;
        const seriesClass = styles[`series${idx % MAX_SERIES_CLASSES}` as keyof typeof styles];
        return <path key={s.id} d={d} className={seriesClass} />;
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Widget component
// ---------------------------------------------------------------------------

/** No per-instance configuration required. */
export type AnalyticsHistoryWidgetConfig = Record<string, never>;

/**
 * Analytics history widget component.
 * @param _props - Standard widget props (size and config unused).
 * @returns History line chart element.
 */
function AnalyticsHistoryWidget(_props: WidgetProps<AnalyticsHistoryWidgetConfig>): JSX.Element {
  const { clientId, accountId, from, to } = useAnalyticsContext();
  const { entries, loading, error } = useAccountHistory({ clientId, accountId }, { from, to });

  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  // Clear any lingering tooltip when the chart context changes — the hover
  // overlay must not persist over a different chart's data.
  useEffect(() => {
    setTooltip(null);
  }, [clientId, accountId, from, to]);

  const series = useMemo(() => buildSeries(entries), [entries]);

  return (
    <div className={styles.widget} data-component="AnalyticsHistoryWidget">
      <span className={styles.title}>Usage History</span>

      <div className={styles.chartWrapper}>
        {loading ? (
          <span className={styles.emptyState} role="status" aria-live="polite">
            Loading data…
          </span>
        ) : error !== null ? (
          <span className={styles.emptyState} role="alert">
            Unable to load data for this period
          </span>
        ) : series.length === 0 ? (
          <span className={styles.emptyState}>No data for this period</span>
        ) : (
          <Chart series={series} from={from} to={to} onTooltip={setTooltip} />
        )}

        {tooltip && (
          // Presentational hover tooltip: no aria-live — it fires on every
          // mousemove and would spam screen-reader announcements. If the
          // chart grows keyboard navigation the tooltip should be re-audited.
          <div className={styles.tooltip} style={{ left: tooltip.x, top: tooltip.y }} role="presentation">
            {tooltip.label}
          </div>
        )}
      </div>

      {/* Legend follows the same loaded/no-error gate as the chart. */}
      {!loading && error === null && series.length > 0 && (
        <div className={styles.legend}>
          {series.map((s, idx) => {
            const swatchClass = styles[`legendSwatch${idx % MAX_SERIES_CLASSES}` as keyof typeof styles];
            return (
              <div key={s.id} className={styles.legendItem}>
                <div className={`${styles.legendSwatch} ${swatchClass}`} aria-hidden="true" />
                <span className={styles.legendLabel}>{s.id}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Widget definition
// ---------------------------------------------------------------------------

/**
 * Analytics history widget definition.
 *
 * Scope: `'account-manager:analytics'` — appears on the analytics page canvas.
 */
export const analyticsHistoryWidgetDefinition: WidgetDefinition<AnalyticsHistoryWidgetConfig> = {
  allowMultiple: false,
  component: AnalyticsHistoryWidget,
  defaultSize: 'full-width',
  description: 'Multi-series time-series line chart of utilization per window.',
  id: 'account-manager:analytics-history',
  name: 'Usage History',
  scope: 'account-manager:analytics',
  supportedSizes: ['full-width', 'large'],
};

/** Type-erased export for use in heterogeneous widget arrays. */
export const analyticsHistoryWidgetDefinitionErased = eraseWidgetConfig(analyticsHistoryWidgetDefinition);
