import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHARED_RENDERER_ROOT = fileURLToPath(new URL('.', import.meta.url));

/**
 * Absolute filesystem root for the shared renderer assets.
 */
export const sharedRendererRoot = SHARED_RENDERER_ROOT;

/**
 * Resolve a shared renderer asset path owned by host-shared.
 * @param relativePath - File path relative to the shared renderer directory.
 * @returns Absolute filesystem path for Vite aliases and tests.
 */
export function resolveSharedRendererAssetPath(relativePath: string): string {
  return path.resolve(SHARED_RENDERER_ROOT, relativePath);
}

/**
 * Shared renderer alias targets consumed by host Vite configs.
 */
export const sharedRendererAliases = {
  './main.scss': resolveSharedRendererAssetPath('main.scss'),
  'drizzle-orm/libsql': resolveSharedRendererAssetPath('server-stub.ts'),
  '@libsql/client': resolveSharedRendererAssetPath('server-stub.ts'),
  libsql: resolveSharedRendererAssetPath('server-stub.ts'),
  'cpu-features': resolveSharedRendererAssetPath('cpu-features-stub.ts'),
  ssh2: resolveSharedRendererAssetPath('ssh2-stub.ts'),
  os: resolveSharedRendererAssetPath('os-stub.ts'),
  'node:os': resolveSharedRendererAssetPath('os-stub.ts'),
} as const;

/**
 * Browser renderer packages that must be resolved as singletons by host Vite configs.
 */
export const sharedRendererDedupe = ['react', 'react-dom'] as const;

/**
 * Workspace and server-only packages excluded from Vite dependency optimization.
 *
 * Workspace packages resolve to TypeScript sources in dev and must be served
 * through Vite's transform pipeline, not pre-bundled. Server-only packages must
 * never reach a browser bundle at all — they are stubbed via
 * {@link sharedRendererAliases}.
 *
 * This list is framework-only by contract: it may name only packages the
 * framework itself imports on the renderer path. Workspace packages outside
 * the framework namespace never belong here — they resolve to workspace
 * sources (never optimizer-eligible) and are reached only through extension
 * browser sources, whose npm dependencies flow in through the descriptor seam
 * instead (see {@link SharedRendererOptimizeDepsOptions.discoveredInclude}).
 */
const SHARED_RENDERER_OPTIMIZE_EXCLUDE = [
  '@makaio/core',
  '@makaio/bus-core',
  '@makaio/ui-kernel',
  '@makaio/ui-components',
  '@makaio/ui-hooks',
  '@makaio/ui-views',
  // Server-only packages that should never be bundled for browser
  '@libsql/client',
  'libsql',
  '@makaio/storage-drizzle',
  'drizzle-orm',
  'drizzle-orm/libsql',
  'drizzle-orm/sqlite-core',
] as const;

/**
 * npm dependencies pre-bundled eagerly because Vite's dependency scanner cannot
 * discover them on its own.
 *
 * The excluded `@makaio/*` workspace packages above are externalized during the
 * scanner's crawl, so the scan stops at every workspace-package import edge.
 * Any npm dependency reachable only *through* an excluded workspace package
 * would otherwise be discovered mid-session on first request, triggering
 * Vite's "optimized dependencies changed. reloading" full reload. During host
 * boot that forced webview reload can crash native webview wrappers, so these
 * dependencies are declared up front.
 *
 * This list carries framework dependencies only. Dependencies reached through
 * extension browser sources are declared per extension via
 * `prebundleDependencies` in `descriptor.json` and merged in through
 * {@link SharedRendererOptimizeDepsOptions.discoveredInclude}.
 *
 * Both sources are kept honest by the desktop smoke drift guard
 * (`expectNoMidBootDependencyReoptimization` in the desktop e2e smoke
 * contract): booting a host from a cold Vite cache fails the smoke test when
 * a mid-boot re-optimization occurs, and the failure message points back
 * here.
 */
const SHARED_RENDERER_OPTIMIZE_INCLUDE = [
  // Renderer singletons and JSX runtimes (see sharedRendererDedupe).
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  // Reached through excluded UI packages (@makaio/ui-hooks, @makaio/ui-views,
  // @makaio/ui-components) and extension browser sources.
  'zustand',
  'zustand/middleware',
  'sonner',
  'clsx',
  'lucide-react',
  'react-grid-layout',
  'react-resizable-panels',
  'd3-shape',
  // Reached through excluded runtime packages (@makaio/bus-core, @makaio/core)
  // and their browser transports.
  'nanoid',
  'p-defer',
  'p-timeout',
  'semver',
  'ws',
  'zod',
] as const;

/** Options for {@link buildSharedRendererOptimizeDeps}. */
export interface SharedRendererOptimizeDepsOptions {
  /**
   * Absolute path to the host's HTML entry crawled by the dependency scanner.
   *
   * This is deliberately the only scanner entry. Extension browser sources
   * must NOT be added here: the dependency scanner runs outside the dev
   * server's plugin pipeline (service browser exports, stub aliases), so
   * crawling raw extension sources follows server-only import edges — for
   * example `@makaio/services-core` → `globby` — and fails the optimizer
   * build. Extension npm dependencies are covered by descriptor-declared
   * `prebundleDependencies` (see {@link discoveredInclude}) and the curated
   * framework include list instead.
   */
  readonly htmlEntry: string;
  /**
   * Extension-declared npm dependencies merged into the eager include list.
   *
   * This is the host seam for dependencies the framework must not enumerate:
   * extension browser bundles reach npm dependencies the framework knows
   * nothing about, and each extension declares them via
   * `prebundleDependencies` in its `descriptor.json`. Hosts aggregate the
   * declarations (see `discoverExtensionBrowserPrebundleDependencies`) and
   * pass them here so a cold-cache boot optimizes them at server start. The
   * curated framework list stays framework-only.
   */
  readonly discoveredInclude?: readonly string[];
}

/**
 * Dependency optimizer options shared by desktop host renderer Vite configs.
 *
 * Structurally compatible with Vite's `optimizeDeps` config field; declared
 * without a `vite` dependency so this module stays a plain asset seam.
 */
export interface SharedRendererOptimizeDeps {
  /** Entry points crawled by the dependency scanner at server start. */
  readonly entries: string[];
  /** Dependencies pre-bundled eagerly because the scanner cannot reach them. */
  readonly include: string[];
  /** Workspace and server-only packages excluded from optimization. */
  readonly exclude: string[];
}

/**
 * Build the `optimizeDeps` options shared by desktop host renderer Vite configs.
 *
 * The curated `include` list moves dependency optimization of everything the
 * scanner cannot reach (see {@link SHARED_RENDERER_OPTIMIZE_INCLUDE}) to
 * server start, so a cold-cache boot never re-optimizes mid-session and never
 * forces a webview reload while the host window is loading. Extension-declared
 * dependencies supplied via `discoveredInclude` are merged additively and
 * deduplicated; the curated framework list itself never carries extension
 * dependencies.
 * Include entries are bare specifiers that Vite resolves from the host's
 * config root. Entries declared by other workspace packages resolve there
 * because the workspace pins the hoisted `node-modules` linker (`nodeLinker`
 * in `.yarnrc.yml`); an isolated linker such as Yarn PnP is not a supported
 * dev layout. If that ever changes, resolution failures surface as Vite
 * `Failed to resolve dependency` warnings and the desktop smoke drift guard
 * fails deterministically — no silent mid-boot reload.
 * @param options - HTML entry crawled by the dependency scanner and optional
 *   extension-declared dependencies to include.
 * @returns Optimizer options for the host's Vite renderer config.
 */
export function buildSharedRendererOptimizeDeps(
  options: SharedRendererOptimizeDepsOptions,
): SharedRendererOptimizeDeps {
  return {
    entries: [options.htmlEntry],
    include: [...new Set([...SHARED_RENDERER_OPTIMIZE_INCLUDE, ...(options.discoveredInclude ?? [])])],
    exclude: [...SHARED_RENDERER_OPTIMIZE_EXCLUDE],
  };
}
