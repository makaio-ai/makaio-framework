import React from 'react';
import { Box, Text } from 'ink';
import type { Account } from '../../bus/schemas.js';
import { AccountRow } from './account-row.js';
import { usageKey, type UsageMap } from '../usage-keys.js';
import type { UsageAwaitingResolutionMap } from '../usage-state.js';

/** Props for ClientGroup */
interface ClientGroupProps {
  /** Client identifier used for usage map lookups */
  clientId: string;
  /** Display name of the client (e.g. "Claude Code") */
  displayName: string;
  /** Accounts for this client */
  accounts: Account[];
  /** Currently keyboard-selected account ID, or null */
  selectedAccountId: string | null;
  /** Usage data keyed by `${clientId}:${accountId}` */
  usageByAccount: UsageMap;
  /** Account ID for which a switch is currently in flight, or null */
  switchingAccountId: string | null;
  /** Usage-resolution markers keyed by {@link usageKey}. */
  usageAwaitingResolutionByAccount: UsageAwaitingResolutionMap;
}

/**
 * Groups accounts under a client heading with optional usage gauges.
 * @param props - Component props
 */
export function ClientGroup({
  clientId,
  displayName,
  accounts,
  selectedAccountId,
  usageByAccount,
  switchingAccountId,
  usageAwaitingResolutionByAccount,
}: ClientGroupProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold>{displayName}</Text>
      {accounts.map((account) => {
        const key = usageKey(clientId, account.id);
        return (
          <AccountRow
            key={account.id}
            account={account}
            selected={account.id === selectedAccountId}
            usage={usageByAccount[key]}
            switching={account.id === switchingAccountId}
            usagePending={usageAwaitingResolutionByAccount[key] === true}
          />
        );
      })}
    </Box>
  );
}
