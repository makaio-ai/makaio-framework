import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioNodeExtension } from '@makaio/contracts';
import { dep, extensionToken } from '@makaio/contracts';
import { registerDrizzleHandlers } from '@makaio/storage-drizzle';
import { ArtifactLifecycleHookRegistry } from './artifact/artifact-lifecycle-hook-registry.js';
import { artifactSchemaRegistryPackage, ArtifactSchemaRegistryToken } from './artifact/packages.js';
import { FacetNamespaceRegistry } from './facet/facet-namespace-registry.js';
import {
  ArtifactViewBuilderRegistryToken,
  artifactViewBuilderRegistryPackage,
  ArtifactViewServiceToken,
  artifactViewServicePackage,
  MaterializationOperationCoordinatorToken,
  materializationOperationCoordinatorPackage,
  SurfaceBindingRegistryToken,
  surfaceBindingRegistryPackage,
} from './materialization/packages.js';
import { CapabilityService } from './capability/capability-service.js';
import { canonicalModelPackage } from './canonical-model/package.js';
import type { IModelRegistryFetcher } from './model-registry/types.js';
import { ModelRegistryService } from './model-registry/model-registry-service.js';
import { ObservedSessionIngestionService } from './session/observed-session-ingestion.js';
import { SessionBridge } from './session/session-bridge.js';
import { SessionOrchestrator } from './session/session-orchestrator.js';
import type { ISessionOrchestrator } from './session/session-orchestrator.js';
import { MakaioSessionService } from './session/session-service.js';
import { ToolApprovalService } from './tool-approval/tool-approval-service.js';
import { ToolRegistry } from './tools/tool-registry.js';
import { TrayMenuService } from './tray-menu/tray-menu-service.js';
import { WorkflowBlockRegistry } from './workflow-blocks/workflow-block-registry.js';
import { TransitionPipelineService } from './workflow-transitions/transition-pipeline-service.js';
import { registerDrizzleSessionStorage } from './session/storage/drizzle-handler.js';
import { registerDrizzleAgentStorage } from './session/storage/agent-drizzle-handler.js';
import { registerFtsSearchHandler } from './session/storage/fts-search-handler.js';
import { registerDrizzleSessionEventStorage } from './session/session-events/drizzle-handler.js';
import { registerDrizzleMessageStorage } from './session/messages/drizzle-handler.js';
import { registerDrizzleMessageRoutingStorage } from './session/message-routing/drizzle-handler.js';
import { registerDrizzleTurnStorage } from './session/turns/drizzle-handler.js';
import { registerDrizzleImportCursorStorage } from './session/import-cursors/drizzle-handler.js';
import {
  registerParentResolver,
  registerCompressLineageResolver,
  registerSpawningToolCallResolver,
  registerSessionDiscoveredHandler,
} from './session/import/index.js';
import { sessionClientAccountLinkingPackage } from './session/client-account-linking/package.js';
import { frameworkShellWindowPackage } from './framework-shell-window-package.js';
import { harnessPackage } from './harness/package.js';
import { subagentServicePackage, SubagentServiceToken } from './subagent/package.js';
import { GitService } from '@makaio/subsystem-git';
import { FileSystemService } from './filesystem/filesystem-service.js';

/** Token for the session storage package. */
export const SessionStorageToken = extensionToken<never>('session-storage');
/** Token for the session bridge service. */
export const SessionBridgeToken = extensionToken<SessionBridge>('session-bridge');
/** Token for the framework session service. */
export const SessionToken = extensionToken<MakaioSessionService>('session');
/** Token for the session orchestrator selected by the runtime composition. */
export const SessionOrchestratorToken = extensionToken<ISessionOrchestrator>('session-orchestrator');
/** Token for the observed-session ingestion service. */
export const ObservedSessionIngestionToken =
  extensionToken<ObservedSessionIngestionService>('observed-session-ingestion');
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
/** Token for the workflow block registry service. */
export const WorkflowBlockRegistryToken = extensionToken<WorkflowBlockRegistry>('workflow-block-registry');
/** Token for the transition pipeline service. */
export const TransitionPipelineToken = extensionToken<TransitionPipelineService>('transition-pipeline');
/** Token for the product filesystem service. */
export const FileSystemToken = extensionToken<FileSystemService>('filesystem');
/** Token for the product git service. */
export const GitToken = extensionToken<GitService>('git');
/** Token for the framework subagent orchestration service. */
export { SubagentServiceToken };
/** Artifact-domain token and package (defined in the artifact domain module). */
export { ArtifactSchemaRegistryToken, artifactSchemaRegistryPackage };
/** Materialization-domain tokens and packages (defined in the materialization domain module). */
export {
  ArtifactViewBuilderRegistryToken,
  artifactViewBuilderRegistryPackage,
  ArtifactViewServiceToken,
  artifactViewServicePackage,
  MaterializationOperationCoordinatorToken,
  materializationOperationCoordinatorPackage,
  SurfaceBindingRegistryToken,
  surfaceBindingRegistryPackage,
};
/** Token for the artifact lifecycle hook registry service. */
export const ArtifactLifecycleHookRegistryToken = extensionToken<ArtifactLifecycleHookRegistry>(
  'artifact-lifecycle-hook-registry',
);
/** Token for the facet namespace registry service. */
export const FacetNamespaceRegistryToken = extensionToken<FacetNamespaceRegistry>('facet-namespace-registry');

/** Package that starts the framework artifact lifecycle hook registry. */
export const artifactLifecycleHookRegistryPackage: MakaioNodeExtension<IMakaioBus> = {
  name: ArtifactLifecycleHookRegistryToken.name,
  displayName: 'Artifact Lifecycle Hook Registry',
  version: '0.1.0',
  critical: true,
  create: (ctx) => new ArtifactLifecycleHookRegistry(ctx.bus),
};

/** Package that starts the framework facet namespace registry. */
export const facetNamespaceRegistryPackage: MakaioNodeExtension<IMakaioBus> = {
  name: FacetNamespaceRegistryToken.name,
  displayName: 'Facet Namespace Registry',
  version: '0.1.0',
  critical: true,
  create: (ctx) => new FacetNamespaceRegistry(ctx.bus),
};

/** Package that registers framework session storage handlers. */
export const sessionStoragePackage: MakaioNodeExtension<IMakaioBus> = {
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
    registerHandlers: registerDrizzleHandlers((bus, db) => {
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
        cleanups.push(registerDrizzleSessionStorage(bus, db));
        cleanups.push(registerDrizzleSessionEventStorage(bus, db));
        cleanups.push(registerDrizzleMessageStorage(bus, db));
        cleanups.push(registerDrizzleMessageRoutingStorage(bus, db));
        cleanups.push(registerDrizzleTurnStorage(bus, db));
        cleanups.push(registerDrizzleAgentStorage(bus, db));
        cleanups.push(registerDrizzleImportCursorStorage(bus, db));
        cleanups.push(registerFtsSearchHandler(bus, db));
        cleanups.push(registerParentResolver(bus, db));
        cleanups.push(registerCompressLineageResolver(bus));
        cleanups.push(registerSpawningToolCallResolver(bus));
        cleanups.push(registerSessionDiscoveredHandler(bus));
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
export const sessionBridgePackage: MakaioNodeExtension<IMakaioBus> = {
  name: SessionBridgeToken.name,
  displayName: 'Session Bridge',
  version: '0.1.0',
  dependencies: [dep(SessionStorageToken.name)],
  critical: true,
  create: (ctx) => new SessionBridge(ctx.bus),
};

/** Package that starts the framework session service. */
export const sessionPackage: MakaioNodeExtension<IMakaioBus> = {
  name: SessionToken.name,
  displayName: 'Session',
  version: '0.1.0',
  dependencies: [dep(SessionBridgeToken.name)],
  critical: true,
  create: (ctx) => new MakaioSessionService(ctx.bus),
};

/** Package that registers the framework session.sendMessage orchestrator. */
export const sessionOrchestratorPackage: MakaioNodeExtension<IMakaioBus> = {
  name: SessionOrchestratorToken.name,
  displayName: 'Session Orchestrator',
  version: '0.1.0',
  dependencies: [dep(SessionToken.name), dep(canonicalModelPackage.name)],
  critical: true,
  runtimeOwnership: { sessionOrchestrator: true },
  create: (ctx) => new SessionOrchestrator(ctx.bus, ctx.machineId),
};

/**
 * Package that starts the observed-session ingestion bridge.
 *
 * Non-critical by design: the framework must boot without observed-session
 * ingestion in degraded scenarios (no client hooks wired, no importers). The
 * dependency on the session bridge transitively guarantees that the session
 * storage handlers are registered before this service subscribes. There is
 * deliberately NO dependency on the log-import service: its `requestOptional`
 * calls degrade gracefully during the boot window and in framework-only
 * hosts, and a hard dependency would invert the package layering.
 */
export const observedSessionIngestionPackage: MakaioNodeExtension<IMakaioBus> = {
  name: ObservedSessionIngestionToken.name,
  displayName: 'Observed-Session Ingestion',
  version: '0.1.0',
  dependencies: [dep(SessionBridgeToken.name)],
  critical: false,
  create: (ctx) => new ObservedSessionIngestionService(ctx.bus),
};

/** Package that starts the framework tool registry. */
export const toolRegistryPackage: MakaioNodeExtension<IMakaioBus> = {
  name: ToolRegistryToken.name,
  displayName: 'Tool Registry',
  version: '0.1.0',
  critical: true,
  create: (ctx) => new ToolRegistry({ bus: ctx.bus }),
};

/** Package that starts the framework tool approval service. */
export const toolApprovalPackage: MakaioNodeExtension<IMakaioBus> = {
  name: ToolApprovalToken.name,
  displayName: 'Tool Approval',
  version: '0.1.0',
  dependencies: [dep(ToolRegistryToken.name)],
  critical: true,
  create: (ctx) => new ToolApprovalService(ctx.bus),
};

/** Package that starts the framework tray menu service. */
export const trayMenuPackage: MakaioNodeExtension<IMakaioBus> = {
  name: TrayMenuToken.name,
  displayName: 'Tray Menu',
  version: '0.1.0',
  critical: true,
  create: (ctx) => new TrayMenuService(ctx.bus),
};

/** Package that starts the framework capability registry. */
export const capabilityPackage: MakaioNodeExtension<IMakaioBus> = {
  name: CapabilityToken.name,
  displayName: 'Capability',
  version: '0.1.0',
  critical: true,
  create: (ctx) => new CapabilityService(ctx.bus),
};

/** Package that starts the framework workflow block registry. */
export const workflowBlockRegistryPackage: MakaioNodeExtension<IMakaioBus> = {
  name: WorkflowBlockRegistryToken.name,
  displayName: 'Workflow Block Registry',
  version: '0.1.0',
  critical: true,
  create: (ctx) => new WorkflowBlockRegistry(ctx.bus),
};

/** Package that starts the transition pipeline service. */
export const transitionPipelinePackage: MakaioNodeExtension<IMakaioBus> = {
  name: TransitionPipelineToken.name,
  displayName: 'Transition Pipeline',
  version: '0.1.0',
  critical: true,
  create: (ctx) => new TransitionPipelineService(ctx.bus),
};

/** Filesystem service package. */
export const fileSystemPackage: MakaioNodeExtension<IMakaioBus> = {
  name: FileSystemToken.name,
  displayName: 'Filesystem',
  version: '0.1.0',
  critical: true,
  create: (ctx) => new FileSystemService(ctx.bus, ctx.machineId),
};

/** Git service package. */
export const gitPackage: MakaioNodeExtension<IMakaioBus> = {
  name: GitToken.name,
  displayName: 'Git',
  version: '0.1.0',
  dependencies: [dep(FileSystemToken.name)],
  critical: true,
  create: (ctx) => new GitService(ctx.bus),
};

/**
 * Create the model-registry package with a host-provided fetcher chain.
 * @param fetcher - Registry fetcher chain for this host.
 * @returns Model-registry package.
 */
export function createModelRegistryPackage(fetcher: IModelRegistryFetcher): MakaioNodeExtension<IMakaioBus> {
  return {
    name: ModelRegistryToken.name,
    displayName: 'Model Registry',
    version: '0.1.0',
    critical: true,
    create: (ctx) => new ModelRegistryService({ bus: ctx.bus, fetcher }),
  };
}

/** Framework packages that are independent of host-specific factories. */
export const frameworkCorePackages: ReadonlyArray<MakaioNodeExtension<IMakaioBus>> = [
  artifactSchemaRegistryPackage,
  artifactLifecycleHookRegistryPackage,
  facetNamespaceRegistryPackage,
  surfaceBindingRegistryPackage,
  materializationOperationCoordinatorPackage,
  artifactViewBuilderRegistryPackage,
  artifactViewServicePackage,
  sessionStoragePackage,
  sessionBridgePackage,
  sessionClientAccountLinkingPackage,
  sessionPackage,
  sessionOrchestratorPackage,
  observedSessionIngestionPackage,
  subagentServicePackage,
  toolRegistryPackage,
  toolApprovalPackage,
  trayMenuPackage,
  capabilityPackage,
  harnessPackage,
  canonicalModelPackage,
  frameworkShellWindowPackage,
  workflowBlockRegistryPackage,
  transitionPipelinePackage,
  gitPackage,
  fileSystemPackage,
];
