/**
 * Detection and selection step component for the setup TUI.
 *
 * Lists detected AI clients, allows selection/deselection with Space,
 * and triggers installation on Enter.
 * @packageDocumentation
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { SetupState } from '@makaio/setup';

/**
 * Props for the DetectStep component.
 */
export interface DetectStepProps {
  /** Current setup state. */
  readonly state: SetupState;
  /**
   * Callback to set a client's selection state.
   * @param clientId - The client identifier to toggle.
   * @param selected - Whether the client should be selected.
   */
  readonly onSelectionChange: (clientId: string, selected: boolean) => void;
  /** Callback to start installing selected clients. */
  readonly onInstall: () => void;
}

/** Indicator shown before detected (available) clients. */
const DETECTED_INDICATOR = '●';

/** Indicator shown before undetected clients. */
const UNDETECTED_INDICATOR = '○';

/**
 * Renders a single client row with selection state, detection indicator,
 * and cursor highlight.
 * @param props - Client row display props.
 */
function ClientRow(props: {
  displayName: string;
  detected: boolean;
  selected: boolean;
  focused: boolean;
}): React.JSX.Element {
  const { displayName, detected, selected, focused } = props;
  const checkbox = selected ? '[x]' : '[ ]';
  const indicator = detected ? DETECTED_INDICATOR : UNDETECTED_INDICATOR;
  const indicatorColor = detected ? 'green' : 'gray';

  return (
    <Box>
      <Text color={focused ? 'cyan' : undefined} bold={focused}>
        {focused ? '❯' : ' '} {checkbox}{' '}
      </Text>
      <Text color={indicatorColor}>{indicator} </Text>
      <Text color={focused ? 'cyan' : undefined} bold={focused}>
        {displayName}
      </Text>
      {!detected && <Text dimColor> (not found)</Text>}
    </Box>
  );
}

/**
 * Renders detected clients with selection markers and handles keyboard navigation.
 *
 * Keyboard controls:
 * - Up/Down arrows: move cursor
 * - Space: toggle selection of the focused client
 * - Enter: proceed with installation
 * @param props - Component props.
 */
export function DetectStep({ state, onSelectionChange, onInstall }: DetectStepProps): React.JSX.Element {
  const [cursor, setCursor] = useState(0);
  const clients = state.detectedClients;
  const selectedCount = state.selectedClientIds.length;

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setCursor((prev) => (clients.length === 0 ? 0 : Math.min(clients.length - 1, prev + 1)));
    } else if (input === ' ') {
      const client = clients[cursor];
      if (client !== undefined) {
        onSelectionChange(client.entry.clientId, !state.selectedClientIds.includes(client.entry.clientId));
      }
    } else if (key.return) {
      onInstall();
    }
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Detected AI Clients
        </Text>
      </Box>

      {clients.length === 0 ? (
        <Box paddingY={1}>
          <Text dimColor>Scanning for installed AI clients...</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {clients.map((client, i) => (
            <ClientRow
              key={client.entry.clientId}
              displayName={client.entry.displayName}
              detected={client.detected}
              selected={state.selectedClientIds.includes(client.entry.clientId)}
              focused={i === cursor}
            />
          ))}
        </Box>
      )}

      <Box marginTop={1} borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false}>
        <Text dimColor>
          {'  '}↑↓ navigate{'  '}Space toggle{'  '}Enter install
        </Text>
      </Box>

      <Box>
        <Text dimColor>
          {'  '}
          {selectedCount} client(s) selected
        </Text>
      </Box>
    </Box>
  );
}
