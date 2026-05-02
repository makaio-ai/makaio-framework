import React from 'react';
import { Box, Text } from 'ink';

/** Terminal rows occupied by {@link ConnectionBanner}. */
export const CONNECTION_BANNER_HEIGHT = 4;

/** Props for ConnectionBanner */
interface ConnectionBannerProps {
  /** Whether a reconnection attempt is currently in progress. */
  reconnecting: boolean;
}

/**
 * Displays a prominent warning banner when the bus connection is lost.
 * @param props - Component props.
 */
export function ConnectionBanner({ reconnecting }: ConnectionBannerProps): React.ReactElement {
  const message = reconnecting ? 'Reconnecting...' : 'Connection lost. Press r to retry.';

  return (
    <Box marginTop={1} borderStyle="single" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        {'⚠ '}
      </Text>
      <Text color="yellow">{message}</Text>
    </Box>
  );
}
