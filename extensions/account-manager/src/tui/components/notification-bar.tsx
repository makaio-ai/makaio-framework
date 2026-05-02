import React from 'react';
import { Box, Text } from 'ink';

/** Terminal rows occupied by {@link NotificationBar}. */
export const NOTIFICATION_BAR_HEIGHT = 2;

/** Props for NotificationBar */
interface NotificationBarProps {
  /** Notification message to display */
  message: string;
}

/**
 * Displays a notification message.
 * @param props - Component props
 */
export function NotificationBar({ message }: NotificationBarProps): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text color="yellow">
        {'ℹ '}
        {message}
      </Text>
    </Box>
  );
}
