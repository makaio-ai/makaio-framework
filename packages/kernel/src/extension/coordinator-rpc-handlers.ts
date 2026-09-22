import type { IMakaioBus } from '@makaio/bus-core';
import { ProviderDefinitionSchema, type ProviderDefinition, ExtensionWarning } from '@makaio/contracts';
import type { CliContribution } from '../cli/types.js';
import { CliRpcSubjects } from '../bus/cli/namespace.js';
import { ExtensionSubjects } from '../observability/extension-namespace.js';
import type { ExtensionInfo } from '../observability/shared-schemas.js';
import type { InstalledExtensionCatalogEntry } from '../observability/installed-extension-catalog-schemas.js';
import { handleListContributions, handleExecute } from './cli-rpc-handlers.js';
import type { SetEnabledResult } from './extension-toggle.js';
import type { ExtensionEntry } from './types.js';

/**
 * Minimal coordinator surface consumed by the RPC registrations.
 */
export interface RpcHost {
  readonly bus: IMakaioBus;
  readonly entries: ReadonlyMap<string, ExtensionEntry>;
  readonly cliContributions: ReadonlyArray<CliContribution>;
  list(): ExtensionInfo[];
  /**
   * Return the current {@link ExtensionInfo} snapshot for a single named
   * package, including `persistedEnabled` — the coordinator implements this
   * with the same `loadEnabled` reader used by `list()`, so the RPC handler
   * below does not need its own access to it.
   * @param name - Extension name to look up.
   * @returns The snapshot, or `null` when unknown.
   */
  getInfo(name: string): ExtensionInfo | null;
  handleSetEnabled(name: string, enabled: boolean): Promise<SetEnabledResult>;
  /**
   * Return every extension package installed on this coordinator's host,
   * enriched with the enablement facts the coordinator holds for each name.
   * @returns The catalog snapshot, or `null` when this runtime has no
   *   installed-extension catalog to report.
   */
  getInstalledCatalog(): Promise<InstalledExtensionCatalogEntry[] | null>;
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
      ctx.setResult({ extension: host.getInfo(ctx.payload.name) });
    }),
  );

  cleanups.push(
    host.bus.on(ExtensionSubjects.setEnabled, async (ctx) => {
      const { success, outcome, reason } = await host.handleSetEnabled(ctx.payload.name, ctx.payload.enabled);
      ctx.setResult({ success, outcome, ...(reason !== undefined && { reason }) });
    }),
  );

  cleanups.push(
    host.bus.on(ExtensionSubjects.catalog, async (ctx) => {
      ctx.setResult({ entries: await host.getInstalledCatalog() });
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
