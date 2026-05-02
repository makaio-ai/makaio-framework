import type { IMakaioBus } from '@makaio/bus-core';
import { ProviderDefinitionSchema, type ProviderDefinition, ExtensionWarning } from '@makaio/contracts';
import type { CliContribution } from '../cli/types.js';
import { CliRpcSubjects } from '../bus/cli/namespace.js';
import { ExtensionSubjects } from '../observability/extension-namespace.js';
import type { ExtensionInfo } from '../observability/shared-schemas.js';
import { handleListContributions, handleExecute } from './cli-rpc-handlers.js';
import { entryToExtensionInfo } from './extension-info.js';
import type { ExtensionEntry } from './types.js';

/**
 * Minimal coordinator surface consumed by the RPC registrations.
 */
export interface RpcHost {
  readonly bus: IMakaioBus;
  readonly entries: ReadonlyMap<string, ExtensionEntry>;
  readonly cliContributions: ReadonlyArray<CliContribution>;
  list(): ExtensionInfo[];
  handleSetEnabled(name: string, enabled: boolean): Promise<boolean>;
}

/**
 * Register extension and CLI RPC handlers on the bus.
 *
 * Extracted from {@link ExtensionCoordinator.load} to keep that class
 * within its line budget. Returns cleanup functions for each handler.
 * @param host - Coordinator surface providing shared state and methods.
 * @returns Array of cleanup functions that unregister the handlers.
 */
export function registerCoordinatorRpcHandlers(host: RpcHost): Array<() => void> {
  const cleanups: Array<() => void> = [];

  cleanups.push(
    host.bus.on(ExtensionSubjects.list, (ctx) => {
      ctx.setResult({ extensions: host.list() });
    }),
  );

  cleanups.push(
    host.bus.on(ExtensionSubjects.get, (ctx) => {
      const entry = host.entries.get(ctx.payload.name);
      ctx.setResult({ extension: entry ? entryToExtensionInfo(entry) : null });
    }),
  );

  cleanups.push(
    host.bus.on(ExtensionSubjects.setEnabled, async (ctx) => {
      const success = await host.handleSetEnabled(ctx.payload.name, ctx.payload.enabled);
      ctx.setResult({ success });
    }),
  );

  cleanups.push(
    host.bus.on(ExtensionSubjects.contributions.catalog, (ctx) => {
      const providers: Array<{
        packageName: string;
        definition: ProviderDefinition;
      }> = [];
      const clients: Array<{
        packageName: string;
        definition: NonNullable<ExtensionEntry['pkg']['clients']>[number];
      }> = [];

      for (const [packageName, entry] of host.entries) {
        if (entry.state !== 'active') continue;
        for (const raw of entry.pkg.providers ?? []) {
          providers.push({ packageName, definition: ProviderDefinitionSchema.parse(raw) });
        }
        for (const definition of entry.pkg.clients ?? []) {
          clients.push({ packageName, definition });
        }
      }

      ctx.setResult({ providers, clients });
    }),
  );

  cleanups.push(
    host.bus.on(CliRpcSubjects.listContributions, (ctx) => {
      ctx.setResult({ contributions: handleListContributions(host.cliContributions) });
    }),
  );

  cleanups.push(
    host.bus.on(CliRpcSubjects.execute, async (ctx) => {
      ctx.setResult(await handleExecute(ctx.payload, host.cliContributions, host.bus));
    }),
  );

  cleanups.push(
    host.bus.on(ExtensionSubjects.warnings.list, (ctx) => {
      const { extensionName } = ctx.payload;

      if (extensionName !== undefined) {
        const entry = host.entries.get(extensionName);
        const entries = entry && entry.warnings.length > 0 ? [{ extensionName, warnings: [...entry.warnings] }] : [];
        ctx.setResult({ entries });
        return;
      }

      const entries: Array<{ extensionName: string; warnings: ExtensionWarning[] }> = [];
      for (const [name, entry] of host.entries) {
        if (entry.warnings.length > 0) {
          entries.push({ extensionName: name, warnings: [...entry.warnings] });
        }
      }
      ctx.setResult({ entries });
    }),
  );

  return cleanups;
}
