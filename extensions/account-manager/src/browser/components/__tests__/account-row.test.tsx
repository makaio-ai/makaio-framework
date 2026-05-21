// @vitest-environment jsdom
/**
 * Tests for the AccountRow web component.
 *
 * Verifies rendering of active/inactive state, optional switch button
 * presence and click handler invocation. Pure component — no bus or hooks.
 */

import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AccountRow } from '../../components/account-row/account-row.js';

describe('AccountRow', () => {
  it('renders the account label', () => {
    render(createElement(AccountRow, { label: 'Work Account', active: true }));
    expect(screen.getByText('Work Account')).toBeInTheDocument();
  });

  it('renders active marker (●) when active', () => {
    render(createElement(AccountRow, { label: 'Test', active: true }));
    expect(screen.getByText('●')).toBeInTheDocument();
  });

  it('renders inactive marker (○) when inactive', () => {
    render(createElement(AccountRow, { label: 'Test', active: false }));
    expect(screen.getByText('○')).toBeInTheDocument();
  });

  it('does not render switch button when onSwitch is absent', () => {
    render(createElement(AccountRow, { label: 'Test', active: false }));
    expect(screen.queryByRole('button', { name: /switch/i })).not.toBeInTheDocument();
  });

  it('renders switch button when onSwitch is provided', () => {
    render(
      createElement(AccountRow, {
        label: 'Test',
        active: false,
        onSwitch: vi.fn(),
      }),
    );
    expect(screen.getByRole('button', { name: 'Switch to Test' })).toBeInTheDocument();
  });

  it('calls onSwitch when switch button is clicked', async () => {
    const user = userEvent.setup();
    const onSwitch = vi.fn();
    render(createElement(AccountRow, { label: 'Test', active: false, onSwitch }));

    const button = screen.getByRole('button', { name: 'Switch to Test' });
    await user.click(button);

    expect(onSwitch).toHaveBeenCalledOnce();
  });

  it('applies markerColor as inline style when provided', () => {
    const { container } = render(
      createElement(AccountRow, {
        label: 'Test',
        active: true,
        markerColor: '#ff6600',
      }),
    );
    const marker = container.querySelector('[aria-hidden="true"]');
    expect(marker).toHaveStyle({ color: '#ff6600' });
  });

  it('does not apply inline markerColor style when omitted', () => {
    const { container } = render(createElement(AccountRow, { label: 'Test', active: true }));
    const marker = container.querySelector('[aria-hidden="true"]');
    expect(marker).not.toHaveAttribute('style');
  });
});
