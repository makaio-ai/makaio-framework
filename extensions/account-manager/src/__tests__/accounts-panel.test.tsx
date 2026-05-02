import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { SourceInfo } from '../bus/schemas.js';
import { AccountsPanel } from '../tui/components/accounts-panel.js';
import { makeAccount } from './fixtures/account.js';
import { createAccountCacheKey } from '../utils/account-key.js';

/**
 * Build a minimal source fixture for panel rendering tests.
 * @param overrides - Per-test source overrides.
 * @returns A valid source descriptor.
 */
function makeSource(overrides: Partial<SourceInfo> = {}): SourceInfo {
  return {
    clientId: 'claude-code',
    displayName: 'Claude Code',
    available: true,
    ...overrides,
  };
}

describe('AccountsPanel', () => {
  it('renders the empty state with watched sources when no accounts are available', () => {
    const { lastFrame } = render(
      <AccountsPanel
        sources={[
          makeSource(),
          makeSource({
            clientId: 'gemini-cli',
            displayName: 'Gemini CLI',
          }),
        ]}
        accountsByClient={{}}
        selectedClientId={null}
        selectedAccountId={null}
        usageByAccount={{}}
        usageAwaitingResolutionByAccount={{}}
        switchingAccountId={null}
        visibleAccountKeys={new Set()}
        visibleConfigIssueIds={new Set()}
        hiddenAbove={0}
        hiddenBelow={0}
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('No credentials detected.');
    expect(output).toContain('Claude Code');
    expect(output).toContain('Gemini CLI');
    expect(output).toContain('Watching for changes...');
  });

  it('renders config-issue banners alongside grouped accounts', () => {
    const { lastFrame } = render(
      <AccountsPanel
        sources={[
          makeSource({
            configIssue: {
              reason: 'Missing credential mode',
              action: 'Press f to switch to file mode',
            },
          }),
          makeSource({
            clientId: 'cursor',
            displayName: 'Cursor',
          }),
        ]}
        accountsByClient={{
          cursor: [makeAccount({ active: true, detectedAt: Date.now(), lastSeenAt: Date.now() })],
        }}
        selectedClientId="cursor"
        selectedAccountId="account-1"
        usageByAccount={{}}
        usageAwaitingResolutionByAccount={{}}
        switchingAccountId={null}
        visibleAccountKeys={new Set([createAccountCacheKey('cursor', 'account-1')])}
        visibleConfigIssueIds={new Set(['claude-code'])}
        hiddenAbove={0}
        hiddenBelow={0}
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('Claude Code');
    expect(output).toContain('Missing credential mode');
    expect(output).toContain('Press f to switch to file mode');
    expect(output).toContain('Cursor');
    expect(output).toContain('Work');
    expect(output).toContain('active');
  });
});
