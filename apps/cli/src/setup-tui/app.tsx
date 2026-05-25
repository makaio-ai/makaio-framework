/**
 * Setup TUI entry point.
 *
 * Exports {@link runSetupTui}, which is lazy-loaded by the `setup` CLI command.
 * Renders the guided first-run flow using Ink components.
 * @packageDocumentation
 */

import React, { useState, useEffect } from 'react';
import { render, Box, Text, useApp } from 'ink';
import type { IMakaioBus } from '@makaio/bus-core';
import { createSetupController } from '@makaio/setup';
import type { SetupState, SetupController } from '@makaio/setup';
import { createSetupRestartAndReconnect } from '../setup-reconnect.js';
import { ConsentStep } from './consent-step.js';
import { DetectStep } from './detect-step.js';
import { ManifestStep } from './manifest-step.js';

/**
 * Configuration for running the setup TUI.
 */
export interface SetupTuiConfig {
  /** Bus instance for RPC communication. */
  readonly bus: IMakaioBus;
  /** Absolute path to the makaio home directory. */
  readonly makaioHome: string;
  /**
   * Absolute path to the project repository root used for manifest discovery.
   * When provided, the setup flow may present a manifest step listing project extensions.
   */
  readonly repoPath?: string;
}

/**
 * Props for the SetupApp component.
 */
interface SetupAppProps {
  /** The setup controller instance. */
  readonly controller: SetupController;
}

/**
 * Root setup TUI component. Subscribes to controller state changes
 * and renders the appropriate step component.
 * @param props - Component props with the setup controller.
 */
function SetupApp({ controller }: SetupAppProps): React.JSX.Element {
  const app = useApp();
  const [state, setState] = useState<SetupState>(controller.state);

  useEffect(() => {
    return controller.onChange(setState);
  }, [controller]);

  useEffect(() => {
    if (state.step === 'complete' || state.error !== null) {
      app.exit();
    }
  }, [state.step, state.error, app]);

  if (state.error !== null) {
    return (
      <Box flexDirection="column" borderStyle="single" borderColor="red" paddingX={1}>
        <Box marginBottom={1}>
          <Text bold color="red">
            Setup Error
          </Text>
        </Box>
        <Text>{state.error}</Text>
        <Box marginTop={1}>
          <Text dimColor>Run `makaio setup` to try again.</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      {renderStep(state, controller)}
    </Box>
  );
}

/**
 * Renders the current step content inside the outer shell.
 * @param state - Current setup state snapshot.
 * @param controller - Setup controller for action callbacks.
 */
function renderStep(state: SetupState, controller: SetupController): React.JSX.Element {
  switch (state.step) {
    case 'consent':
      return (
        <ConsentStep
          state={state}
          onAccept={() => {
            void controller.actions.acceptConsent();
          }}
        />
      );
    case 'detect':
      return (
        <DetectStep
          state={state}
          onSelectionChange={(clientId, selected) => controller.actions.setClientSelected(clientId, selected)}
          onInstall={() => {
            void controller.advance();
          }}
        />
      );
    case 'manifest':
      return (
        <ManifestStep
          state={state}
          onSelectionChange={(spec, selected) => controller.actions.setManifestExtensionSelected(spec, selected)}
          onInstall={() => {
            void controller.advance();
          }}
        />
      );
    case 'install':
      return (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold color="cyan">
              Installing Extensions
            </Text>
          </Box>
          {state.extensionInstallProgress.map((p) => (
            <Box key={p.packageName}>
              <Text color={p.success ? 'green' : 'red'}>{p.success ? '✓' : '✗'} </Text>
              <Text>{p.packageName}</Text>
              {p.error && <Text color="red"> — {p.error}</Text>}
            </Box>
          ))}
          {state.restartRequested && (
            <Box marginTop={1}>
              <Text color="yellow">{'⟳ '}</Text>
              <Text dimColor>Restarting kernel...</Text>
            </Box>
          )}
        </Box>
      );
    case 'managed':
      return (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold color="cyan">
              Configuring Managed Binaries
            </Text>
          </Box>
          {state.managedBinaryStates.map((s) => {
            const icon = s.recommendation === 'managed-active' ? '✓' : '⟳';
            const color = s.recommendation === 'managed-active' ? 'green' : 'yellow';
            return (
              <Box key={s.clientId}>
                <Text color={color}>{icon} </Text>
                <Text>{s.binaryName}</Text>
                {s.pinnedVersion && <Text dimColor> v{s.pinnedVersion}</Text>}
              </Box>
            );
          })}
        </Box>
      );
    case 'complete':
      return (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold color="green">
              ✓ Setup Complete
            </Text>
          </Box>
          {state.result !== null && (
            <>
              {state.result.installedPackages.length > 0 && (
                <Box>
                  <Text dimColor>Extensions: </Text>
                  <Text>{state.result.installedPackages.join(', ')}</Text>
                </Box>
              )}
              {state.result.activatedBinaries.length > 0 && (
                <Box>
                  <Text dimColor>Activated: </Text>
                  <Text>{state.result.activatedBinaries.join(', ')}</Text>
                </Box>
              )}
              {state.result.installedPackages.length === 0 && state.result.activatedBinaries.length === 0 && (
                <Text dimColor>No changes needed.</Text>
              )}
            </>
          )}
          <Box marginTop={1}>
            <Text dimColor>Run `makaio serve` to start the runtime.</Text>
          </Box>
        </Box>
      );
  }
}

/**
 * Runs the setup TUI. Creates the controller, renders the Ink app,
 * and waits for the flow to reach completion or error.
 * @param config - TUI configuration with bus and makaioHome.
 */
export async function runSetupTui(config: SetupTuiConfig): Promise<void> {
  const controller = await createSetupController({
    bus: config.bus,
    makaioHome: config.makaioHome,
    repoPath: config.repoPath,
    restartAndReconnect: createSetupRestartAndReconnect(),
  });

  const { waitUntilExit } = render(<SetupApp controller={controller} />);
  await waitUntilExit();
}
