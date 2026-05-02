import React from 'react';
import { Box, Text } from 'ink';
import type { UsageWindow } from '../../bus/schemas.js';
import { clampUtilization, deriveGaugeState } from '../../utils/gauge-thresholds.js';
import { formatDuration } from '../../utils/format-duration.js';

/** Number of characters in the progress bar body. */
const BAR_WIDTH = 10;

/** Filled block character for the progress bar. */
const FILLED = '▓';

/** Empty block character for the progress bar. */
const EMPTY = '░';

/** Props for UsageGauge */
interface UsageGaugeProps {
  /** The usage window to visualise. */
  window: UsageWindow;
  /**
   * When true the parent snapshot is stale (last upstream fetch failed).
   * The gauge dims the bar and appends a staleness marker so the data is
   * clearly not-authoritative.
   */
  stale?: boolean;
}

/**
 * Renders a single usage window as a Unicode progress bar with reset time.
 *
 * Example output:
 * ```
 * 5 Hour  [▓▓▓▓▓▓▓░░░ 73%]  resets in 2h 14m
 * ```
 * @param props - Component props.
 */
export function UsageGauge({ window, stale = false }: UsageGaugeProps): React.ReactElement {
  const fraction = clampUtilization(window.utilization / 100);
  const filledCount = Math.round(fraction * BAR_WIDTH);
  const emptyCount = BAR_WIDTH - filledCount;
  const bar = FILLED.repeat(filledCount) + EMPTY.repeat(emptyCount);
  const pct = `${Math.round(fraction * 100)}%`;
  // When resetsAt is in the past the reported window has rolled over but we
  // have no fresh data to replace the utilization figure. Rendering
  // "resets in 0m" would misrepresent an indefinitely-expired snapshot as a
  // freshly-reset one; "reset pending" makes the uncertainty explicit.
  const msUntilReset = window.resetsAt - Date.now();
  const resetsText = msUntilReset <= 0 ? 'reset pending' : `resets in ${formatDuration(msUntilReset)}`;

  const stateColors = { normal: 'green', warning: 'yellow', critical: 'red' } as const;
  const barColor = stale ? 'gray' : stateColors[deriveGaugeState(fraction)];

  return (
    <Box gap={1}>
      <Text dimColor>{window.label.padEnd(16)}</Text>
      <Text color={barColor} dimColor={stale}>{`[${bar} ${pct.padStart(4)}]`}</Text>
      <Text dimColor>{stale ? `${resetsText} (stale)` : resetsText}</Text>
    </Box>
  );
}
