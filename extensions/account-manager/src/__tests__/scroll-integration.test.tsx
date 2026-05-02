/**
 * Integration tests for scroll-gated AccountsPanel rendering.
 *
 * Verifies that the viewport gating and scroll indicators work correctly in an
 * actual rendered component using `ink-testing-library`. Tests exercise:
 * - No-scroll baseline: all accounts visible, no indicators shown
 * - Scroll below: hidden-below count and indicator rendered
 * - Scroll above: hidden-above count and indicator rendered
 * - Both indicators simultaneously
 * - Config-issue banners gated by `visibleConfigIssueIds`
 */
import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { Account, SourceInfo } from '../bus/schemas.js';
import { AccountsPanel } from '../tui/components/accounts-panel.js';
import type { UsageMap } from '../tui/usage-keys.js';
import type { UsageAwaitingResolutionMap } from '../tui/usage-state.js';
import { createAccountCacheKey } from '../utils/account-key.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build a minimal account fixture with a distinct label.
 * @param id - Stable unique identifier for this account.
 * @param label - Human-readable label rendered in the TUI.
 * @param active - Whether this account is marked active.
 * @returns A valid {@link Account} object.
 */
function makeAccount(id: string, label: string, active: boolean = false): Account {
  return { id, label, metadata: {}, active, detectedAt: 0, lastSeenAt: 0 };
}

/**
 * Build a healthy source fixture (no config issue).
 * @param clientId - Stable identifier for the credential source.
 * @param displayName - Human-readable name shown as group header.
 * @returns A valid {@link SourceInfo} object.
 */
function makeSource(clientId: string, displayName: string): SourceInfo {
  return { clientId, displayName, available: true };
}

/**
 * Build a source fixture that carries a config issue.
 * @param clientId - Stable identifier for the credential source.
 * @param displayName - Human-readable name shown as group header.
 * @returns A valid {@link SourceInfo} object with a config issue.
 */
function makeSourceWithIssue(clientId: string, displayName: string): SourceInfo {
  return {
    clientId,
    displayName,
    available: false,
    configIssue: { reason: 'Bad config', action: 'Run fix command' },
  };
}

/** Empty usage maps shared across all tests that do not exercise usage. */
const NO_USAGE: UsageMap = {};
const NO_PENDING: UsageAwaitingResolutionMap = {};

/**
 * Builds visible account keys for one source.
 * @param clientId - Source client identifier.
 * @param accountIds - Visible account IDs.
 * @returns Set accepted by AccountsPanel.
 */
function visibleKeys(clientId: string, accountIds: readonly string[]): ReadonlySet<string> {
  return new Set(accountIds.map((accountId) => createAccountCacheKey(clientId, accountId)));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AccountsPanel — scroll integration', () => {
  it('renders all accounts and no scroll indicators when nothing is hidden', () => {
    const accounts = [makeAccount('a1', 'Account A'), makeAccount('a2', 'Account B')];

    const { lastFrame } = render(
      <AccountsPanel
        sources={[makeSource('src1', 'Source One')]}
        accountsByClient={{ src1: accounts }}
        selectedClientId={null}
        selectedAccountId={null}
        usageByAccount={NO_USAGE}
        usageAwaitingResolutionByAccount={NO_PENDING}
        switchingAccountId={null}
        visibleAccountKeys={visibleKeys('src1', ['a1', 'a2'])}
        visibleConfigIssueIds={new Set()}
        hiddenAbove={0}
        hiddenBelow={0}
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('Account A');
    expect(output).toContain('Account B');
    expect(output).not.toContain('more above');
    expect(output).not.toContain('more below');
  });

  it('shows only visible accounts and the "more below" indicator when items are hidden below', () => {
    const accounts = [
      makeAccount('a1', 'Account A'),
      makeAccount('a2', 'Account B'),
      makeAccount('a3', 'Account C'),
      makeAccount('a4', 'Account D'),
      makeAccount('a5', 'Account E'),
    ];

    // Only the first two indices are visible; three are hidden below.
    const { lastFrame } = render(
      <AccountsPanel
        sources={[makeSource('src1', 'Source One')]}
        accountsByClient={{ src1: accounts }}
        selectedClientId={null}
        selectedAccountId={null}
        usageByAccount={NO_USAGE}
        usageAwaitingResolutionByAccount={NO_PENDING}
        switchingAccountId={null}
        visibleAccountKeys={visibleKeys('src1', ['a1', 'a2'])}
        visibleConfigIssueIds={new Set()}
        hiddenAbove={0}
        hiddenBelow={3}
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('Account A');
    expect(output).toContain('Account B');
    expect(output).not.toContain('Account C');
    expect(output).not.toContain('Account D');
    expect(output).not.toContain('Account E');
    expect(output).toContain('3 more below');
    expect(output).not.toContain('more above');
  });

  it('shows only visible accounts and the "more above" indicator when items are hidden above', () => {
    const accounts = [
      makeAccount('a1', 'Account A'),
      makeAccount('a2', 'Account B'),
      makeAccount('a3', 'Account C'),
      makeAccount('a4', 'Account D'),
    ];

    // Only the last two indices are visible; two are hidden above.
    const { lastFrame } = render(
      <AccountsPanel
        sources={[makeSource('src1', 'Source One')]}
        accountsByClient={{ src1: accounts }}
        selectedClientId={null}
        selectedAccountId={null}
        usageByAccount={NO_USAGE}
        usageAwaitingResolutionByAccount={NO_PENDING}
        switchingAccountId={null}
        visibleAccountKeys={visibleKeys('src1', ['a3', 'a4'])}
        visibleConfigIssueIds={new Set()}
        hiddenAbove={2}
        hiddenBelow={0}
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).not.toContain('Account A');
    expect(output).not.toContain('Account B');
    expect(output).toContain('Account C');
    expect(output).toContain('Account D');
    expect(output).toContain('2 more above');
    expect(output).not.toContain('more below');
  });

  it('shows both scroll indicators when items are hidden above and below', () => {
    const accounts = [
      makeAccount('a1', 'Account A'),
      makeAccount('a2', 'Account B'),
      makeAccount('a3', 'Account C'),
      makeAccount('a4', 'Account D'),
    ];

    // Only the middle index is visible; one hidden above, two hidden below.
    const { lastFrame } = render(
      <AccountsPanel
        sources={[makeSource('src1', 'Source One')]}
        accountsByClient={{ src1: accounts }}
        selectedClientId={null}
        selectedAccountId={null}
        usageByAccount={NO_USAGE}
        usageAwaitingResolutionByAccount={NO_PENDING}
        switchingAccountId={null}
        visibleAccountKeys={visibleKeys('src1', ['a2'])}
        visibleConfigIssueIds={new Set()}
        hiddenAbove={1}
        hiddenBelow={2}
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('1 more above');
    expect(output).toContain('2 more below');
  });

  it('does not render a config-issue banner when the clientId is absent from visibleConfigIssueIds', () => {
    const { lastFrame } = render(
      <AccountsPanel
        sources={[makeSourceWithIssue('broken-src', 'Broken Source')]}
        accountsByClient={{ 'broken-src': [makeAccount('a1', 'Account A')] }}
        selectedClientId={null}
        selectedAccountId={null}
        usageByAccount={NO_USAGE}
        usageAwaitingResolutionByAccount={NO_PENDING}
        switchingAccountId={null}
        visibleAccountKeys={visibleKeys('broken-src', ['a1'])}
        visibleConfigIssueIds={new Set()}
        hiddenAbove={0}
        hiddenBelow={0}
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).not.toContain('Bad config');
    expect(output).not.toContain('Run fix command');
  });

  it('renders a config-issue banner when the clientId is present in visibleConfigIssueIds', () => {
    const { lastFrame } = render(
      <AccountsPanel
        sources={[makeSourceWithIssue('broken-src', 'Broken Source')]}
        accountsByClient={{ 'broken-src': [makeAccount('a1', 'Account A')] }}
        selectedClientId={null}
        selectedAccountId={null}
        usageByAccount={NO_USAGE}
        usageAwaitingResolutionByAccount={NO_PENDING}
        switchingAccountId={null}
        visibleAccountKeys={visibleKeys('broken-src', ['a1'])}
        visibleConfigIssueIds={new Set(['broken-src'])}
        hiddenAbove={0}
        hiddenBelow={0}
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('Bad config');
    expect(output).toContain('Run fix command');
  });
});
