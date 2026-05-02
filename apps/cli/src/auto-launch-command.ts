import type { Command } from 'commander';
import type { IMakaioBus } from '@makaio/bus-core';
import { PlatformSubjects } from '@makaio/contracts';
import { connectBusClient, probeHealth, resolveClientAuth } from './bus-client.js';

const UNSUPPORTED_MSG = 'Auto-launch is not supported on this platform.';

/**
 * Register the `auto-launch` subcommand with enable/disable/status actions.
 * @param program - The root Commander program.
 */
export function registerAutoLaunchCommand(program: Command): void {
  const cmd = program.command('auto-launch').description('Manage whether Makaio starts automatically at login');

  cmd
    .command('enable')
    .description('Enable auto-launch at login')
    .action(async () => {
      const bus = await requireBus();
      try {
        const result = await bus.requestOptional(PlatformSubjects.autoLaunch.enable, { hidden: true });
        if (!result.handled) {
          console.info(UNSUPPORTED_MSG);
          return;
        }
        if (result.data.enabled) {
          console.info('Auto-launch enabled. Makaio will start at login.');
        } else {
          console.error(`Failed to enable auto-launch: ${result.data.error ?? 'unknown error'}`);
          process.exitCode = 1;
        }
      } finally {
        bus.disconnect();
      }
    });

  cmd
    .command('disable')
    .description('Disable auto-launch at login')
    .action(async () => {
      const bus = await requireBus();
      try {
        const result = await bus.requestOptional(PlatformSubjects.autoLaunch.disable, {});
        if (!result.handled) {
          console.info(UNSUPPORTED_MSG);
          return;
        }
        if (result.data.disabled) {
          console.info('Auto-launch disabled.');
        } else {
          console.error(`Failed to disable auto-launch: ${result.data.error ?? 'unknown error'}`);
          process.exitCode = 1;
        }
      } finally {
        bus.disconnect();
      }
    });

  cmd
    .command('status')
    .description('Show auto-launch status')
    .action(async () => {
      const bus = await requireBus();
      try {
        const result = await bus.requestOptional(PlatformSubjects.autoLaunch.getStatus, {});
        if (!result.handled || !result.data.supported) {
          console.info(UNSUPPORTED_MSG);
        } else if (result.data.enabled) {
          console.info('Auto-launch is enabled. Makaio starts at login.');
        } else {
          console.info('Auto-launch is disabled.');
        }
      } finally {
        bus.disconnect();
      }
    });
}

/**
 * Connect to a running Makaio instance, or fail with an actionable message.
 * @returns A connected bus client.
 */
async function requireBus(): Promise<IMakaioBus> {
  const health = await probeHealth();
  if (!health) {
    console.error('Makaio is not running. Start it with: makaio open');
    process.exit(1);
  }
  const auth = resolveClientAuth(health);
  return connectBusClient(undefined, { auth });
}
