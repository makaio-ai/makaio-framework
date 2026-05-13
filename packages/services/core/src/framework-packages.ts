import type { MakaioExtension } from '@makaio/contracts';
import { dep, extensionToken } from '@makaio/contracts';
import { registerDrizzleHandlers } from '@makaio/storage-drizzle';
import { CapabilityService } from './capability/capability-service.js';
import { canonicalModelPackage } from './canonical-model/package.js';
import type { IModelRegistryFetcher } from './model-registry/types.js';
import { ModelRegistryService } from './model-registry/model-registry-service.js';
import { SessionBridge } from './session/session-bridge.js';
import { SessionOrchestrator } from './session/session-orchestrator.js';
import type { ISessionOrchestrator } from './session/session-orchestrator.js';
import { MakaioSessionService } from './session/session-service.js';
import { ToolApprovalService } from './tool-approval/tool-approval-service.js';
import { ToolRegistry } from './tools/tool-registry.js';
import { TrayMenuService } from './tray-menu/tray-menu-service.js';
import { registerDrizzleSessionStorage } from './session/storage/drizzle-handler.js';
import { registerDrizzleAgentStorage } from './session/storage/agent-drizzle-handler.js';
import { registerFtsSearchHandler } from './session/storage/fts-search-handler.js';
import { registerDrizzleSessionEventStorage } from './session/session-events/drizzle-handler.js';
import { registerDrizzleMessageStorage } from './session/messages/drizzle-handler.js';
import { registerDrizzleMessageRoutingStorage } from './session/message-routing/drizzle-handler.js';
import { registerDrizzleTurnStorage } from './session/turns/drizzle-handler.js';
import { registerDrizzleImportCursorStorage } from './session/import-cursors/drizzle-handler.js';
import {
  registerDrizzleAdapterSessionStorage,
  registerParentResolver,
  registerCompressLineageResolver,
  registerSpawningToolCallResolver,
  registerSessionDiscoveredHandler,
  registerCreateAndLinkHandler,
} from './session/adapter-sessions/index.js';
import { sessionClientAccountLinkingPackage } from './session/client-account-linking/package.js';
import { frameworkShellWindowPackage } from './framework-shell-window-package.js';
import { harnessPackage } from './harness/package.js';

/** Token for the session storage package. */
export const SessionStorageToken = extensionToken<never>('session-storage');
/** Token for the session bridge service. */
export const SessionBridgeToken = extensionToken<SessionBridge>('session-bridge');
/** Token for the framework session service. */
export const SessionToken = extensionToken<MakaioSessionService>('session');
/** Token for the session orchestrator selected by the runtime composition. */
export const SessionOrchestratorToken = extensionToken<ISessionOrchestrator>('session-orchestrator');
/** Token for the framework tool registry. */
export const ToolRegistryToken = extensionToken<ToolRegistry>('tool-registry');
/** Token for the framework tool approval service. */
export const ToolApprovalToken = extensionToken<ToolApprovalService>('tool-approval');
/** Token for the framework tray menu service. */
export const TrayMenuToken = extensionToken<TrayMenuService>('tray-menu');
/** Token for the capability registry service. */
export const CapabilityToken = extensionToken<CapabilityService>('capability');
/** Token for the model registry service. */
export const ModelRegistryToken = extensionToken<ModelRegistryService>('model-registry');

/** Package that registers framework session storage handlers. */
export const sessionStoragePackage: MakaioExtension = {
  name: SessionStorageToken.name,
  displayName: 'Session Storage',
  version: '0.1.0',
  critical: true,
  storage: {
    /**
     * Register all framework session storage handlers.
     * @param bus - Application bus instance.
     * @param db - Database handle supplied by the coordinator.
     * @returns Cleanup function for all registered handlers.
     */
    registerHandlers: registerDrizzleHandlers((bus, db, _ctx) => {
      const cleanups: Array<() => void> = [];
      const runCleanups = (phase: 'rollback' | 'shutdown'): void => {
        for (let index = cleanups.length - 1; index >= 0; index -= 1) {
          try {
            cleanups[index]?.();
          } catch (error) {
            console.warn(`[sessionStoragePackage] cleanup failed during ${phase}:`, error);
          }
        }
        cleanups.length = 0;
      };
      try {
        cleanups.push(registerDrizzleSessionStorage(bus, db, _ctx));
        cleanups.push(registerDrizzleSessionEventStorage(bus, db, _ctx));
        cleanups.push(registerDrizzleMessageStorage(bus, db, _ctx));
        cleanups.push(registerDrizzleMessageRoutingStorage(bus, db, _ctx));
        cleanups.push(registerDrizzleTurnStorage(bus, db, _ctx));
        cleanups.push(registerDrizzleAgentStorage(bus, db, _ctx));
        cleanups.push(registerDrizzleImportCursorStorage(bus, db, _ctx));
        cleanups.push(registerFtsSearchHandler(bus, db));
        cleanups.push(registerDrizzleAdapterSessionStorage(bus, db, _ctx));
        cleanups.push(registerParentResolver(bus, db));
        cleanups.push(registerCompressLineageResolver(bus));
        cleanups.push(registerSpawningToolCallResolver(bus));
        cleanups.push(registerSessionDiscoveredHandler(bus));
        cleanups.push(registerCreateAndLinkHandler(bus));
      } catch (error) {
        runCleanups('rollback');
        throw error;
      }
      return () => {
        runCleanups('shutdown');
      };
    }),
  },
};

/** Package that bridges agent events into session storage. */
export const sessionBridgePackage: MakaioExtension = {
  name: SessionBridgeToken.name,
  displayName: 'Session Bridge',
  version: '0.1.0',
  dependencies: [dep(SessionStorageToken.name)],
  critical: true,
  create: (ctx) => new SessionBridge(ctx.bus),
};

/** Package that starts the framework session service. */
export const sessionPackage: MakaioExtension = {
  name: SessionToken.name,
  displayName: 'Session',
  version: '0.1.0',
  dependencies: [dep(SessionBridgeToken.name)],
  critical: true,
  create: (ctx) => new MakaioSessionService(ctx.bus),
};

/** Package that registers the framework session.sendMessage orchestrator. */
export const sessionOrchestratorPackage: MakaioExtension = {
  name: SessionOrchestratorToken.name,
  displayName: 'Session Orchestrator',
  version: '0.1.0',
  dependencies: [dep(SessionToken.name), dep(canonicalModelPackage.name)],
  critical: true,
  runtimeOwnership: { sessionOrchestrator: true },
  create: (ctx) => new SessionOrchestrator(ctx.bus, ctx.machineId),
};

/** Package that starts the framework tool registry. */
export const toolRegistryPackage: MakaioExtension = {
  name: ToolRegistryToken.name,
  displayName: 'Tool Registry',
  version: '0.1.0',
  critical: true,
  create: (ctx) => new ToolRegistry({ bus: ctx.bus }),
};

/** Package that starts the framework tool approval service. */
export const toolApprovalPackage: MakaioExtension = {
  name: ToolApprovalToken.name,
  displayName: 'Tool Approval',
  version: '0.1.0',
  dependencies: [dep(ToolRegistryToken.name)],
  critical: true,
  create: (ctx) => new ToolApprovalService(ctx.bus),
};

/** Package that starts the framework tray menu service. */
export const trayMenuPackage: MakaioExtension = {
  name: TrayMenuToken.name,
  displayName: 'Tray Menu',
  version: '0.1.0',
  critical: true,
  create: (ctx) => new TrayMenuService(ctx.bus),
};

/** Package that starts the framework capability registry. */
export const capabilityPackage: MakaioExtension = {
  name: CapabilityToken.name,
  displayName: 'Capability',
  version: '0.1.0',
  critical: true,
  create: (ctx) => new CapabilityService(ctx.bus),
};

/**
 * Create the model-registry package with a host-provided fetcher chain.
 * @param fetcher - Registry fetcher chain for this host.
 * @returns Model-registry package.
 */
export function createModelRegistryPackage(fetcher: IModelRegistryFetcher): MakaioExtension {
  return {
    name: ModelRegistryToken.name,
    displayName: 'Model Registry',
    version: '0.1.0',
    critical: true,
    create: (ctx) => new ModelRegistryService({ bus: ctx.bus, fetcher }),
  };
}

/** Framework packages that are independent of host-specific factories. */
export const frameworkCorePackages: ReadonlyArray<MakaioExtension> = [
  sessionStoragePackage,
  sessionBridgePackage,
  sessionClientAccountLinkingPackage,
  sessionPackage,
  sessionOrchestratorPackage,
  toolRegistryPackage,
  toolApprovalPackage,
  trayMenuPackage,
  capabilityPackage,
  harnessPackage,
  canonicalModelPackage,
  frameworkShellWindowPackage,
];
