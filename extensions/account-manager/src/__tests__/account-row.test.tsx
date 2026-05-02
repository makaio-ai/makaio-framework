import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { Account, AccountUsage } from '../bus/schemas.js';
import { AccountRow } from '../tui/components/account-row.js';

/**
 * Builds a minimal account fixture for AccountRow rendering tests.
 * @returns A valid account object.
 */
function makeAccount(): Account {
  return {
    id: 'account-1',
    label: 'Work Account',
    metadata: {},
    active: true,
    detectedAt: 1_000,
    lastSeenAt: 1_000,
  };
}

/**
 * Builds an AccountUsage snapshot with an explicit window list.
 * @param windows - Usage windows to include.
 * @returns A usage snapshot for rendering.
 */
function makeUsage(windows: AccountUsage['windows']): AccountUsage {
  return {
    fetchedAt: Date.now(),
    windows,
  };
}

describe('AccountRow', () => {
  it('renders an explicit empty-state message when usage has no windows', () => {
    const { lastFrame } = render(
      React.createElement(AccountRow, {
        account: makeAccount(),
        selected: false,
        usage: makeUsage([]),
      }),
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('Last updated:');
    expect(output).toContain('No usage windows reported');
  });
});
