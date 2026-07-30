/**
 * Central source of truth for the `@makaio/framework` public distribution surface.
 *
 * This module is intentionally free of runtime dependencies so it can be imported
 * in both build scripts and validation tooling without side effects.
 * @packageDocumentation
 */

/**
 * One entry in the framework dist assembly map.
 *
 * `subpath` is the key under `./dist/` in the assembled umbrella package.
 * `sourceDist` is the path relative to the framework root where each workspace
 * package emits its build output.
 * `packageName` identifies the workspace package responsible for this subpath.
 */
export interface FrameworkDistSubpath {
  readonly subpath: string;
  readonly sourceDist: string;
  readonly packageName: string;
}

/**
 * Maps a workspace package to its primary umbrella import subpath.
 *
 * Used by import-rewriting tooling to redirect bare workspace imports
 * (e.g. `@makaio/bus-core`) to the stable public subpath
 * (e.g. `@makaio/framework/bus`) in built output.
 *
 * `packageRoot` is the path relative to the framework root where the
 * workspace package lives (its directory, not its dist).
 */
export interface FrameworkPublicPackageSubpath {
  readonly packageName: string;
  readonly frameworkSubpath: string;
  readonly packageRoot: string;
}

/**
 * The complete set of dist subpaths assembled into `@makaio/framework`.
 *
 * Each entry describes how one workspace package's build output is copied
 * into the umbrella dist. Packages that contribute multiple subpaths
 * (e.g. `tools/testing`) appear more than once.
 */
export const FRAMEWORK_DIST_SUBPATHS = [
  { subpath: 'bus', sourceDist: 'core/bus-core/dist', packageName: '@makaio/bus-core' },
  { subpath: 'core', sourceDist: 'core/makaio-core/dist', packageName: '@makaio/core' },
  { subpath: 'utils', sourceDist: 'packages/utils/dist', packageName: '@makaio/utils' },
  { subpath: 'service-base', sourceDist: 'packages/service-base/dist', packageName: '@makaio/service-base' },
  { subpath: 'contracts', sourceDist: 'core/contracts/dist', packageName: '@makaio/contracts' },
  { subpath: 'hooks', sourceDist: 'packages/hooks/dist', packageName: '@makaio/hooks' },
  { subpath: 'inbound-hooks', sourceDist: 'packages/inbound-hooks/dist', packageName: '@makaio/inbound-hooks' },
  { subpath: 'kernel', sourceDist: 'packages/kernel/dist', packageName: '@makaio/kernel' },
  { subpath: 'services', sourceDist: 'services/core/dist', packageName: '@makaio/services-core' },
  { subpath: 'clients', sourceDist: 'subsystems/client/dist', packageName: '@makaio/subsystem-client' },
  { subpath: 'git', sourceDist: 'subsystems/git/dist', packageName: '@makaio/subsystem-git' },
  {
    subpath: 'services/log-import',
    sourceDist: 'services/log-import/dist',
    packageName: '@makaio/services-log-import',
  },
  { subpath: 'providers', sourceDist: 'packages/providers/dist', packageName: '@makaio/providers' },
  { subpath: 'storage', sourceDist: 'storage/core/dist', packageName: '@makaio/storage-core' },
  { subpath: 'storage/drizzle', sourceDist: 'storage/drizzle/dist', packageName: '@makaio/storage-drizzle' },
  {
    subpath: 'storage/handlers',
    sourceDist: 'storage/handlers/dist',
    packageName: '@makaio/storage-handlers',
  },
  {
    subpath: 'adapter-subsystem',
    sourceDist: 'subsystems/adapter/dist',
    packageName: '@makaio/subsystem-adapter',
  },
  { subpath: 'adapters', sourceDist: 'adapters/core/dist', packageName: '@makaio/ai-adapters-core' },
  {
    subpath: 'adapters/stream-session',
    sourceDist: 'adapters/shared/stream-session/dist',
    packageName: '@makaio/ai-adapters-stream-session',
  },
  {
    subpath: 'adapters/stream-session/testing',
    sourceDist: 'adapters/shared/stream-session/dist/testing',
    packageName: '@makaio/ai-adapters-stream-session',
  },
  {
    subpath: 'adapters/acp-client',
    sourceDist: 'adapters/shared/acp-client/dist',
    packageName: '@makaio/ai-adapters-acp-client',
  },
  {
    subpath: 'adapters/claude',
    sourceDist: 'adapters/shared/claude-shared/dist',
    packageName: '@makaio/ai-adapters-claude-shared',
  },
  { subpath: 'tools', sourceDist: 'core/tools-core/dist', packageName: '@makaio/tools-core' },
  { subpath: 'tools/testing', sourceDist: 'core/tools-core/dist/testing', packageName: '@makaio/tools-core' },
  { subpath: 'node/bus-server', sourceDist: 'packages/bus-server/dist', packageName: '@makaio/bus-server' },
  { subpath: 'node/transports', sourceDist: 'transports/ws/dist', packageName: '@makaio/bus-transport-websocket' },
  {
    subpath: 'node/machine-identity',
    sourceDist: 'packages/machine-identity/dist',
    packageName: '@makaio/machine-identity',
  },
  { subpath: 'testing', sourceDist: 'packages/test-utils/dist', packageName: '@makaio/test-utils' },
  { subpath: 'ui-kernel', sourceDist: 'ui/kernel/dist', packageName: '@makaio/ui-kernel' },
  { subpath: 'ui-components', sourceDist: 'ui/components/dist', packageName: '@makaio/ui-components' },
  { subpath: 'ui-hooks', sourceDist: 'ui/hooks/dist', packageName: '@makaio/ui-hooks' },
  { subpath: 'ui-views', sourceDist: 'ui/views/dist', packageName: '@makaio/ui-views' },
  { subpath: 'runtime-node', sourceDist: 'runtimes/node/dist', packageName: '@makaio/runtime-node' },
  { subpath: 'runtime-bun', sourceDist: 'runtimes/bun/dist', packageName: '@makaio/runtime-bun' },
  { subpath: 'rules', sourceDist: 'packages/rules/dist', packageName: '@makaio/rules' },
  { subpath: 'expression', sourceDist: 'packages/expression/dist', packageName: '@makaio/expression' },
  {
    subpath: 'mcp-http-server',
    sourceDist: 'subsystems/mcp-http-server/dist',
    packageName: '@makaio/subsystem-mcp-http-server',
  },
  {
    subpath: 'workflow-engine',
    sourceDist: 'subsystems/workflow-engine/dist',
    packageName: '@makaio/subsystem-workflow-engine',
  },
] as const satisfies readonly FrameworkDistSubpath[];

/**
 * The set of workspace packages whose sources feed the framework distribution.
 *
 * Used by CI, validation tooling, portable package generation, and dev-publish
 * candidate detection to share one framework build-input package boundary.
 */
export const FRAMEWORK_BUILD_PACKAGE_NAMES = [
  '@makaio/build-tooling',
  '@makaio/bus-core',
  '@makaio/core',
  '@makaio/utils',
  '@makaio/service-base',
  '@makaio/subsystem-adapter',
  '@makaio/contracts',
  '@makaio/hooks',
  '@makaio/inbound-hooks',
  '@makaio/kernel',
  '@makaio/services-core',
  '@makaio/subsystem-client',
  '@makaio/subsystem-git',
  '@makaio/file-watcher',
  '@makaio/services-log-import',
  '@makaio/providers',
  '@makaio/storage-core',
  '@makaio/storage-drizzle',
  '@makaio/storage-handlers',
  '@makaio/ai-adapters-core',
  '@makaio/ai-adapters-stream-session',
  '@makaio/ai-adapters-acp-client',
  '@makaio/ai-adapters-claude-shared',
  '@makaio/tools-core',
  '@makaio/bus-server',
  '@makaio/bus-transport-websocket',
  '@makaio/machine-identity',
  '@makaio/test-utils',
  '@makaio/ui-kernel',
  '@makaio/ui-theme',
  '@makaio/ui-hooks',
  '@makaio/ui-components',
  '@makaio/ui-views',
  '@makaio/runtime-node',
  '@makaio/runtime-bun',
  '@makaio/rules',
  '@makaio/expression',
  '@makaio/subsystem-mcp-http-server',
  '@makaio/subsystem-workflow-engine',
] as const;

/**
 * Non-workspace repository paths whose source contents feed the framework
 * distribution.
 *
 * Workspace package inputs are represented by {@link FRAMEWORK_BUILD_PACKAGE_NAMES};
 * this list is only for build helpers that are not package-owned.
 */
export const FRAMEWORK_NON_WORKSPACE_BUILD_INPUT_PATHS = [
  'scripts/lib/framework-dist-declarations.ts',
  'scripts/lib/framework-dist-verifier.ts',
  'scripts/lib/runtime-migration-assets.ts',
  // Root TypeScript configs shape the distribution's compilation and
  // declaration output (tsconfig.build.json scopes tsgo declaration
  // emission; the others are extended by it and by every package build).
  // They are dist build-stamp inputs, so a change to any of them changes
  // the published artifact and must map to the framework package here.
  'tsconfig.build.base.json',
  'tsconfig.build.json',
  'tsconfig.json',
] as const;

/** Source migration chain copied into the framework runtime distribution. */
export const FRAMEWORK_RUNTIME_MIGRATION_CHAIN_ROOT = 'storage/migrations/drizzle';

/**
 * Maps each publicly distributed workspace package to its primary framework
 * subpath and its workspace root relative to the framework root.
 *
 * Packages that appear in multiple `FRAMEWORK_DIST_SUBPATHS` entries (e.g.
 * `@makaio/tools-core` contributes both `tools` and `tools/testing`) are
 * listed once here, pointing at the primary subpath.
 *
 * Used by import-rewriting plugins to redirect workspace imports to the stable
 * umbrella subpath in built output.
 */
export const FRAMEWORK_PUBLIC_PACKAGE_SUBPATHS = [
  { packageName: '@makaio/bus-core', frameworkSubpath: 'bus', packageRoot: 'core/bus-core' },
  { packageName: '@makaio/core', frameworkSubpath: 'core', packageRoot: 'core/makaio-core' },
  { packageName: '@makaio/utils', frameworkSubpath: 'utils', packageRoot: 'packages/utils' },
  { packageName: '@makaio/service-base', frameworkSubpath: 'service-base', packageRoot: 'packages/service-base' },
  { packageName: '@makaio/contracts', frameworkSubpath: 'contracts', packageRoot: 'core/contracts' },
  { packageName: '@makaio/hooks', frameworkSubpath: 'hooks', packageRoot: 'packages/hooks' },
  { packageName: '@makaio/inbound-hooks', frameworkSubpath: 'inbound-hooks', packageRoot: 'packages/inbound-hooks' },
  { packageName: '@makaio/kernel', frameworkSubpath: 'kernel', packageRoot: 'packages/kernel' },
  { packageName: '@makaio/services-core', frameworkSubpath: 'services', packageRoot: 'services/core' },
  { packageName: '@makaio/subsystem-client', frameworkSubpath: 'clients', packageRoot: 'subsystems/client' },
  { packageName: '@makaio/subsystem-git', frameworkSubpath: 'git', packageRoot: 'subsystems/git' },
  {
    packageName: '@makaio/services-log-import',
    frameworkSubpath: 'services/log-import',
    packageRoot: 'services/log-import',
  },
  { packageName: '@makaio/providers', frameworkSubpath: 'providers', packageRoot: 'packages/providers' },
  { packageName: '@makaio/storage-core', frameworkSubpath: 'storage', packageRoot: 'storage/core' },
  {
    packageName: '@makaio/storage-drizzle',
    frameworkSubpath: 'storage/drizzle',
    packageRoot: 'storage/drizzle',
  },
  {
    packageName: '@makaio/storage-handlers',
    frameworkSubpath: 'storage/handlers',
    packageRoot: 'storage/handlers',
  },
  {
    packageName: '@makaio/subsystem-adapter',
    frameworkSubpath: 'adapter-subsystem',
    packageRoot: 'subsystems/adapter',
  },
  { packageName: '@makaio/ai-adapters-core', frameworkSubpath: 'adapters', packageRoot: 'adapters/core' },
  {
    packageName: '@makaio/ai-adapters-stream-session',
    frameworkSubpath: 'adapters/stream-session',
    packageRoot: 'adapters/shared/stream-session',
  },
  {
    packageName: '@makaio/ai-adapters-acp-client',
    frameworkSubpath: 'adapters/acp-client',
    packageRoot: 'adapters/shared/acp-client',
  },
  {
    packageName: '@makaio/ai-adapters-claude-shared',
    frameworkSubpath: 'adapters/claude',
    packageRoot: 'adapters/shared/claude-shared',
  },
  { packageName: '@makaio/tools-core', frameworkSubpath: 'tools', packageRoot: 'core/tools-core' },
  { packageName: '@makaio/bus-server', frameworkSubpath: 'node/bus-server', packageRoot: 'packages/bus-server' },
  {
    packageName: '@makaio/bus-transport-websocket',
    frameworkSubpath: 'node/transports',
    packageRoot: 'transports/ws',
  },
  {
    packageName: '@makaio/machine-identity',
    frameworkSubpath: 'node/machine-identity',
    packageRoot: 'packages/machine-identity',
  },
  { packageName: '@makaio/test-utils', frameworkSubpath: 'testing', packageRoot: 'packages/test-utils' },
  { packageName: '@makaio/ui-kernel', frameworkSubpath: 'ui-kernel', packageRoot: 'ui/kernel' },
  { packageName: '@makaio/ui-components', frameworkSubpath: 'ui-components', packageRoot: 'ui/components' },
  { packageName: '@makaio/ui-hooks', frameworkSubpath: 'ui-hooks', packageRoot: 'ui/hooks' },
  { packageName: '@makaio/ui-views', frameworkSubpath: 'ui-views', packageRoot: 'ui/views' },
  { packageName: '@makaio/runtime-node', frameworkSubpath: 'runtime-node', packageRoot: 'runtimes/node' },
  { packageName: '@makaio/runtime-bun', frameworkSubpath: 'runtime-bun', packageRoot: 'runtimes/bun' },
  { packageName: '@makaio/rules', frameworkSubpath: 'rules', packageRoot: 'packages/rules' },
  { packageName: '@makaio/expression', frameworkSubpath: 'expression', packageRoot: 'packages/expression' },
  {
    packageName: '@makaio/subsystem-mcp-http-server',
    frameworkSubpath: 'mcp-http-server',
    packageRoot: 'subsystems/mcp-http-server',
  },
  {
    packageName: '@makaio/subsystem-workflow-engine',
    frameworkSubpath: 'workflow-engine',
    packageRoot: 'subsystems/workflow-engine',
  },
] as const satisfies readonly FrameworkPublicPackageSubpath[];

let distSubpathMapCache: ReadonlyMap<string, FrameworkDistSubpath> | undefined;

/**
 * Returns a map from subpath to `FrameworkDistSubpath` entry for O(1) lookup.
 * @returns Map keyed by subpath string.
 */
export function getFrameworkDistSubpathMap(): ReadonlyMap<string, FrameworkDistSubpath> {
  distSubpathMapCache ??= new Map(FRAMEWORK_DIST_SUBPATHS.map((entry) => [entry.subpath, entry]));
  return distSubpathMapCache;
}

/**
 * Finds the `FrameworkPublicPackageSubpath` entry for a given workspace package name.
 * @param packageName - The npm package name (e.g. `@makaio/bus-core`).
 * @returns The matching entry, or `undefined` if the package is not in the public surface.
 */
export function getFrameworkPublicPackageByName(packageName: string): FrameworkPublicPackageSubpath | undefined {
  return FRAMEWORK_PUBLIC_PACKAGE_SUBPATHS.find((entry) => entry.packageName === packageName);
}
