import React from 'react';
import { Box, Text } from 'ink';
import type { Account, SourceInfo } from '../../bus/schemas.js';
import { ClientGroup } from './client-group.js';
import type { UsageMap } from '../usage-keys.js';
import type { UsageAwaitingResolutionMap } from '../usage-state.js';
import { createAccountCacheKey } from '../../utils/account-key.js';

/** Terminal rows added by the panel's vertical padding. */
export const ACCOUNTS_PANEL_VERTICAL_PADDING_HEIGHT = 2;

interface AccountsPanelProps {
  readonly sources: SourceInfo[];
  readonly accountsByClient: Record<string, Account[]>;
  readonly selectedClientId: string | null;
  readonly selectedAccountId: string | null;
  readonly usageByAccount: UsageMap;
  readonly usageAwaitingResolutionByAccount: UsageAwaitingResolutionMap;
  readonly switchingAccountId: string | null;
  readonly visibleAccountKeys: ReadonlySet<string>;
  readonly visibleConfigIssueIds: ReadonlySet<string>;
  readonly hiddenAbove: number;
  readonly hiddenBelow: number;
}

/**
 * Renders either the empty state or the grouped account list for the TUI.
 * @param props - Component props.
 * @returns Ink element for the main account panel.
 */
export function AccountsPanel({
  sources,
  accountsByClient,
  selectedClientId,
  selectedAccountId,
  usageByAccount,
  usageAwaitingResolutionByAccount,
  switchingAccountId,
  visibleAccountKeys,
  visibleConfigIssueIds,
  hiddenAbove,
  hiddenBelow,
}: AccountsPanelProps): React.ReactElement {
  const hasConfigIssue = sources.some((source) => Boolean(source.configIssue));
  const hasContent = Object.values(accountsByClient).some((accounts) => accounts.length > 0) || hasConfigIssue;

  if (!hasContent) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text>No credentials detected.</Text>
        <Text />
        <Text>Log in to a supported tool and credentials will</Text>
        <Text>appear automatically:</Text>
        <Text />
        {sources.map((source) => (
          <Text key={source.clientId}>
            {'  '}• {source.displayName}
          </Text>
        ))}
        <Text />
        <Text dimColor>Watching for changes...</Text>
      </Box>
    );
  }

  const groupElements = sources.reduce<React.ReactElement[]>((acc, source) => {
    let element: React.ReactElement | null = null;

    if (source.configIssue) {
      if (visibleConfigIssueIds.has(source.clientId)) {
        element = (
          <Box key={source.clientId} flexDirection="column">
            <Text bold>{source.displayName}</Text>
            <Text color="yellow">
              {'  '}⚠ {source.configIssue.reason}
            </Text>
            <Text color="yellow">
              {'    '}
              {source.configIssue.action}
            </Text>
          </Box>
        );
      }
    } else {
      const accounts = accountsByClient[source.clientId] ?? [];
      if (accounts.length > 0) {
        const visibleAccounts = accounts.filter((account) =>
          visibleAccountKeys.has(createAccountCacheKey(source.clientId, account.id)),
        );
        if (visibleAccounts.length > 0) {
          element = (
            <ClientGroup
              key={source.clientId}
              clientId={source.clientId}
              displayName={source.displayName}
              accounts={visibleAccounts}
              selectedAccountId={selectedClientId === source.clientId ? selectedAccountId : null}
              usageByAccount={usageByAccount}
              usageAwaitingResolutionByAccount={usageAwaitingResolutionByAccount}
              switchingAccountId={switchingAccountId}
            />
          );
        }
      }
    }

    if (element !== null) {
      if (acc.length > 0) {
        acc.push(<Text key={`margin-${source.clientId}`} />);
      }
      acc.push(element);
    }

    return acc;
  }, []);

  return (
    <Box flexDirection="column" paddingY={1}>
      {hiddenAbove > 0 && (
        <Text dimColor>
          {'  ▲ '}
          {hiddenAbove} more above
        </Text>
      )}
      {groupElements}
      {hiddenBelow > 0 && (
        <Text dimColor>
          {'  ▼ '}
          {hiddenBelow} more below
        </Text>
      )}
    </Box>
  );
}
