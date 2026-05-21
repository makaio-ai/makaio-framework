// @vitest-environment jsdom
/**
 * Tests for the UsageGauge React component.
 *
 * Verifies rendering, semantic state derivation, percentage clamping, and
 * accessibility attributes. Pure component — no bus or hooks involved.
 */

import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UsageGauge } from '../../components/usage-gauge/usage-gauge.js';

describe('UsageGauge', () => {
  it('renders the label', () => {
    render(createElement(UsageGauge, { label: '5 Hour', percentage: 0.5 }));
    expect(screen.getByText('5 Hour')).toBeInTheDocument();
  });

  it('renders the percentage rounded to integer', () => {
    render(createElement(UsageGauge, { label: 'Test', percentage: 0.736 }));
    expect(screen.getByText('74%')).toBeInTheDocument();
  });

  it('clamps percentage above 1 to 100%', () => {
    render(createElement(UsageGauge, { label: 'Test', percentage: 1.5 }));
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('clamps negative percentage to 0%', () => {
    render(createElement(UsageGauge, { label: 'Test', percentage: -0.2 }));
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('shows 0% for non-finite percentage', () => {
    render(createElement(UsageGauge, { label: 'Test', percentage: NaN }));
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('renders reset countdown when provided', () => {
    render(
      createElement(UsageGauge, {
        label: 'Test',
        percentage: 0.5,
        resetCountdown: '2h 14m',
      }),
    );
    expect(screen.getByText('resets in 2h 14m')).toBeInTheDocument();
  });

  it('does not render countdown when omitted', () => {
    render(createElement(UsageGauge, { label: 'Test', percentage: 0.5 }));
    expect(screen.queryByText(/resets in/)).not.toBeInTheDocument();
  });

  it('exposes correct aria attributes on the track', () => {
    render(createElement(UsageGauge, { label: '5 Hour', percentage: 0.73 }));
    const progressbar = screen.getByRole('progressbar', { name: '5 Hour' });
    expect(progressbar).toHaveAttribute('aria-valuenow', '73');
    expect(progressbar).toHaveAttribute('aria-valuemin', '0');
    expect(progressbar).toHaveAttribute('aria-valuemax', '100');
  });

  it('exposes aria-valuenow matching the clamped percentage on the progressbar', () => {
    render(createElement(UsageGauge, { label: 'Test', percentage: 0.6 }));
    // The aria-valuenow attribute is the correct semantic contract surface;
    // testing the inline fill style would be a brittle implementation detail.
    expect(screen.getByRole('progressbar', { name: 'Test' })).toHaveAttribute('aria-valuenow', '60');
  });
});
