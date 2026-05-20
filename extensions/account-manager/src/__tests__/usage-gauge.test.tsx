// @vitest-environment jsdom
/**
 * Tests for the UsageGauge TUI component.
 *
 * Exercises the progress bar rendering logic against real Ink output via
 * `ink-testing-library`. Verifies that filled/empty block characters, the
 * percentage label, and the "resets in" countdown are all rendered correctly.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { UsageGauge } from '../tui/components/usage-gauge.js';
import type { UsageWindow } from '../bus/schemas.js';

/**
 * Build a minimal UsageWindow fixture.
 * @param overrides - Partial UsageWindow fields to merge.
 * @returns A complete UsageWindow object.
 */
function makeWindow(overrides: Partial<UsageWindow> = {}): UsageWindow {
  return {
    id: '5h',
    label: '5 Hour',
    utilization: 50,
    resetsAt: Date.now() + 3_600_000, // 1 hour from now
    windowSeconds: 18000,
    ...overrides,
  };
}

describe('UsageGauge', () => {
  it('renders filled and empty blocks proportionally', () => {
    const window = makeWindow({ utilization: 50 });
    const { lastFrame } = render(React.createElement(UsageGauge, { window }));
    const output = lastFrame() ?? '';
    // 50% of 10 chars = 5 filled, 5 empty
    expect(output).toContain('▓▓▓▓▓░░░░░');
  });

  it('renders 100% utilization as fully filled bar', () => {
    const window = makeWindow({ utilization: 100 });
    const { lastFrame } = render(React.createElement(UsageGauge, { window }));
    const output = lastFrame() ?? '';
    expect(output).toContain('▓▓▓▓▓▓▓▓▓▓');
    expect(output).not.toContain('░');
  });

  it('renders 0% utilization as fully empty bar', () => {
    const window = makeWindow({ utilization: 0 });
    const { lastFrame } = render(React.createElement(UsageGauge, { window }));
    const output = lastFrame() ?? '';
    expect(output).toContain('░░░░░░░░░░');
    expect(output).not.toContain('▓');
  });

  it('renders percentage rounded to integer', () => {
    const window = makeWindow({ utilization: 73.6 });
    const { lastFrame } = render(React.createElement(UsageGauge, { window }));
    const output = lastFrame() ?? '';
    expect(output).toContain('74%');
  });

  it('renders "resets in Xh Ym" for a future reset time', () => {
    // Relative offsets (Date.now() + delta) make these tests deterministic without
    // fake timers — the gauge only floor-truncates to whole minutes.
    // Add an extra 30 s so flooring to minutes remains stable under timing jitter.
    const resetsAt = Date.now() + 2 * 3_600_000 + 14 * 60_000 + 30_000; // ~2h 14m 30s
    const window = makeWindow({ resetsAt });
    const { lastFrame } = render(React.createElement(UsageGauge, { window }));
    const output = lastFrame() ?? '';
    expect(output).toContain('resets in 2h 14m');
  });

  it('renders "resets in Xm" when less than one hour remains', () => {
    // Use a large enough buffer (1 hour + 30 s) so the floor to minutes is stable
    // under normal test-runner timing jitter.
    const resetsAt = Date.now() + 30 * 60_000 + 30_000; // ~30m 30s
    const window = makeWindow({ resetsAt });
    const { lastFrame } = render(React.createElement(UsageGauge, { window }));
    const output = lastFrame() ?? '';
    // Accepts either "30m" or "30m 0s" style — just verify no hours component.
    expect(output).toMatch(/resets in 30m/);
  });

  it('renders "reset pending" for an already-expired window', () => {
    // When resetsAt is in the past, utilization is no longer authoritative:
    // the window has rolled over but we have no fresh data to replace the
    // figure. "reset pending" makes that uncertainty explicit so the UI does
    // not misrepresent an expired snapshot as freshly-reset.
    const window = makeWindow({ resetsAt: Date.now() - 1000 });
    const { lastFrame } = render(React.createElement(UsageGauge, { window }));
    const output = lastFrame() ?? '';
    expect(output).toContain('reset pending');
    expect(output).not.toContain('resets in 0m');
  });

  it('appends a "(stale)" marker when the parent snapshot is stale', () => {
    const window = makeWindow({ resetsAt: Date.now() + 60 * 60_000 });
    const { lastFrame } = render(React.createElement(UsageGauge, { window, stale: true }));
    const output = lastFrame() ?? '';
    expect(output).toContain('(stale)');
  });

  it('clamps utilization above 100 to a full bar', () => {
    const window = makeWindow({ utilization: 150 });
    const { lastFrame } = render(React.createElement(UsageGauge, { window }));
    const output = lastFrame() ?? '';
    expect(output).toContain('▓▓▓▓▓▓▓▓▓▓');
    expect(output).toContain('100%');
  });

  it('renders the window label', () => {
    const window = makeWindow({ label: 'Sonnet (7 Day)' });
    const { lastFrame } = render(React.createElement(UsageGauge, { window }));
    const output = lastFrame() ?? '';
    expect(output).toContain('Sonnet (7 Day)');
  });
});
