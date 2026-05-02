import React from 'react';
import { Box, Text } from 'ink';

/** Terminal rows occupied by {@link Header}. */
export const HEADER_HEIGHT = 1;

/**
 * Header bar showing the app title.
 */
export function Header(): React.ReactElement {
  return (
    <Box>
      <Text bold>Account Manager</Text>
    </Box>
  );
}
