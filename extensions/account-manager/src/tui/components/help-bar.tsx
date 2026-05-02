import React from 'react';
import { Box, Text } from 'ink';

/** Terminal rows occupied by {@link HelpBar}. */
export const HELP_BAR_HEIGHT = 3;

interface HelpBarProps {
  showNavigationShortcut: boolean;
  showSwitchShortcut: boolean;
  showLabelShortcut: boolean;
  showDeleteShortcut: boolean;
  showFileModeShortcut: boolean;
  showQuitShortcut: boolean;
}

/**
 * Bottom bar showing keyboard shortcuts.
 * @param props - Component props.
 */
export function HelpBar({
  showNavigationShortcut,
  showSwitchShortcut,
  showLabelShortcut,
  showDeleteShortcut,
  showFileModeShortcut,
  showQuitShortcut,
}: HelpBarProps): React.ReactElement {
  const shortcuts = [
    showNavigationShortcut ? '↑↓ navigate' : null,
    showSwitchShortcut ? '⏎ switch' : null,
    showLabelShortcut ? 'l label' : null,
    showDeleteShortcut ? 'd delete' : null,
    showFileModeShortcut ? 'f file-mode' : null,
    showQuitShortcut ? 'q quit' : null,
  ].filter((shortcut): shortcut is string => shortcut !== null);

  return (
    <Box marginTop={1} borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false}>
      <Text dimColor>{`  ${shortcuts.join('  ')}`}</Text>
    </Box>
  );
}
