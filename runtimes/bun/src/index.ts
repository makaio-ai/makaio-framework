/**
 * `@makaio/runtime-bun` — Bun-native platform package.
 *
 * Re-exports a curated portable surface of `@makaio/runtime-node` and
 * overlays Bun-specific implementations for:
 * - Bus transport: {@link BunBusServerTransportProvider} (native Bun WebSocket)
 * - Route graph fetch: {@link createBunRouteGraphFetch} (native WebSocket upgrade + HTTP facade)
 * - Server address helper: {@link resolveListeningPort}
 * - Boot entry point: {@link bootMakaioRuntime} (accepts a Bun server instance)
 *
 * Callers should import from `@makaio/runtime-bun` instead of
 * `@makaio/runtime-node` to pick up the Bun-native implementations
 * automatically.
 */

// Re-export the supported portable runtime-node surface. Retired bootstrap
// helpers stay removed here too: this pre-release package prefers one current
// API over compatibility re-exports of deleted seams.
export type { FrameworkModuleResolver } from '@makaio/runtime-node';
export {
  registerAdapterNameResolver,
  runMigrations,
  loadOrCreateMachineIdentity,
  machineKeysExist,
  validateMachineKeys,
  type PersistedMachineIdentity,
  type MachineKeyStatus,
  type MachineKeyValidation,
  FileConfigStorage,
  resolveStaticModelRegistryPath,
  isMissingOptionalRuntimePackage,
  tryImport,
  StoredCredentialProvider,
  NodeCredentialProvider,
  type CredentialProvider,
  FileRegistryCache,
  FilesystemDescriptorDiscovery,
  ExplicitDescriptorDiscovery,
  type DiscoveredExtension,
  type ExtensionDiscovery,
  type FilesystemDescriptorDiscoveryOptions,
  loadExtensions,
  isWithinDirectory,
  isMakaioExtensionLike,
  isCliContributionLike,
  entrypointStem,
  resolveConventionEntrypoint,
  type DescriptorSourcePackageGroup,
  type LoadExtensionsOptions,
  bridgeExtensionBrowserEntries,
  type BridgeBrowserOptions,
  bootMakaioRuntimeCore,
  type CoreBootOptions,
  type ServerTransportProvider,
  type MakaioRuntime,
  type TransportReadyInfo,
  createHonoRouteGraph,
  createHttpRouteGraphBuilder,
  type HonoRouteGraph,
  type HonoRouteGraphOptions,
  type HttpRouteGraphBuilder,
  type HttpRouteContribution,
  type HttpContributionPhase,
} from '@makaio/runtime-node';

// Bun-specific overrides
export {
  BunBusServerTransportProvider,
  type BunBusServerTransportOptions,
  type BunWebSocketHandler,
} from './bus-server-transport.js';
export {
  createBunRouteGraphFetch,
  type BunRouteGraphFetch,
  type BunRouteGraphUpgradeServer,
} from './bun-route-graph-fetch.js';
export { resolveListeningPort, type BunServer, type BunServerAddress } from './http-server-utils.js';
export { bootMakaioRuntime, type BunBootMakaioRuntimeOptions } from './boot.js';
export {
  collectActiveBunHostPackages,
  composeBunHostFetch,
  composeBunHostWebSocket,
  createBunHostRouter,
  normalizeBunHostPackages,
  type ActiveBunHostExtensionIterator,
  type BunHostContribution,
  type BunHostExtensionPackage,
  type BunHostRouter,
} from './bun-host-contributions.js';
export { createGracefulShutdown, type BunGracefulShutdownOptions } from './graceful-shutdown.js';
export {
  readBunServerEnv,
  type BunServerEnvConfig,
  type InvalidBunServerEnvPolicy,
  type ReadBunServerEnvOptions,
} from './server-env.js';
