/**
 * Manifest step component for the setup TUI.
 *
 * Displays project-manifest extension specs available for installation.
 * Users toggle selections with number keys and press Enter to proceed.
 * @packageDocumentation
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import type { SetupState } from '@makaio/setup';

/** Props for the {@link ManifestStep} component. */
export interface ManifestStepProps {
  /** Current setup state snapshot. */
  readonly state: SetupState;
  /**
   * Callback to set a manifest extension spec's selection state.
   * @param spec - The extension spec string (e.g. `@scope/pkg@1.0.0`).
   * @param selected - Whether the spec should be selected.
   */
  readonly onSelectionChange: (spec: string, selected: boolean) => void;
  /** Callback to begin installation of the selected extensions. */
  readonly onInstall: () => void;
}

/**
 * Interactive TUI step showing project manifest extensions available for install.
 *
 * Keyboard controls:
 * - Number keys (1–9): toggle the corresponding extension's selection
 * - Enter: proceed with installation of selected extensions
 * @param props - Component props.
 * @returns React element.
 */
export function ManifestStep({ state, onSelectionChange, onInstall }: ManifestStepProps): React.JSX.Element {
  useInput((input, key) => {
    if (key.return) {
      onInstall();
      return;
    }
    const index = Number.parseInt(input, 10) - 1;
    const spec = state.manifestExtensionSpecs[index];
    if (spec !== undefined) {
      onSelectionChange(spec, !state.selectedManifestExtensionSpecs.includes(spec));
    }
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Project Extensions
        </Text>
      </Box>
      {state.manifestExtensionSpecs.map((spec, index) => {
        const selected = state.selectedManifestExtensionSpecs.includes(spec);
        const mismatch = state.manifestExtensionMismatches.find((entry) => entry.manifest.spec === spec);
        return (
          <Box key={spec} flexDirection="column">
            <Box>
              <Text color={selected ? 'green' : 'gray'}>{selected ? 'x' : ' '} </Text>
              <Text>{index + 1}. </Text>
              <Text>{spec}</Text>
            </Box>
            {mismatch !== undefined && (
              <Box paddingLeft={4}>
                <Text color="yellow">
                  installed {mismatch.installedVersion}, project requires {mismatch.manifest.version}
                </Text>
              </Box>
            )}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>Press number to toggle, Enter to install.</Text>
      </Box>
    </Box>
  );
}
