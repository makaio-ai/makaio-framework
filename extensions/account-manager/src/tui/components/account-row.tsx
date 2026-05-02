import React from 'react';
import { Box, Text } from 'ink';
import type { Account, AccountUsage } from '../../bus/schemas.js';
import { collectMetaParts, displayLabel } from '../../utils/format-account-display.js';
import { ACTIVE_INDICATOR, INACTIVE_INDICATOR } from '../../utils/display-constants.js';
import { formatRelativeTime } from '../../utils/format-relative-time.js';
import { getUsageAuthPendingDisplayText } from '../../utils/usage-auth-state.js';
import { UsageGauge } from './usage-gauge.js';

/** Props for AccountRow */
interface AccountRowProps {
  /** The account to display */
  account: Account;
  /** Whether this row is keyboard-selected */
  selected: boolean;
  /** Usage snapshot for this account, if available */
  usage?: AccountUsage;
  /** Whether an account-switch is in flight for this account */
  switching?: boolean;
  /** Whether the TUI currently has a usage refresh attempt in flight for this account */
  usagePending?: boolean;
}

/**
 * Displays a single account with its status indicator and optional usage gauges.
 * @param props - Component props
 */
export function AccountRow({ account, selected, usage, switching, usagePending }: AccountRowProps): React.ReactElement {
  const indicator = account.active ? ACTIVE_INDICATOR : INACTIVE_INDICATOR;
  const label = displayLabel(account);
  const metaParts = collectMetaParts(account.metadata);
  const pendingText = getUsageAuthPendingDisplayText(account.metadata, usagePending === true);
  if (pendingText) metaParts.push(pendingText);
  const metaText = metaParts.join(', ');
  const status = switching ? 'switching...' : account.active ? 'active' : 'available';
  const lastUpdatedAt = usage?.lastOkAt ?? usage?.fetchedAt ?? account.lastSeenAt;
  const lastUpdatedText = formatRelativeTime(lastUpdatedAt);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={selected ? 'cyan' : undefined} bold={selected}>
          {'  '}
          {indicator} {label}
        </Text>
        {metaText && <Text dimColor> ({metaText})</Text>}
        <Box flexGrow={1} />
        <Text dimColor>{status}</Text>
      </Box>
      <Box marginLeft={4}>
        <Text dimColor>Last updated: {lastUpdatedText}</Text>
      </Box>
      {usage && usage.windows.length === 0 && (
        <Box marginLeft={4}>
          <Text dimColor>No usage windows reported</Text>
        </Box>
      )}
      {usage &&
        usage.windows.map((win) => (
          <Box key={win.id} marginLeft={4}>
            <UsageGauge window={win} stale={usage.stale === true} />
          </Box>
        ))}
    </Box>
  );
}
