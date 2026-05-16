/**
 * Lazy runtime singleton for the /runtime entry point.
 *
 * Boots an embedded Makaio runtime in-process the first time it is needed,
 * then reuses the single instance for all subsequent operations.
 *
 * The runtime uses a {@link NoTransportProvider} so no HTTP/WebSocket server
 * is started — all bus traffic flows in-process. Runtime package discovery
 * includes the adapter, provider, and headless tool packages carried by this
 * package, then falls back to filesystem discovery for user-installed
 * extensions.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { MakaioBus } from '@makaio/bus-core';
import { parseExtensionDescriptor } from '@makaio/contracts';
import { NoTransportProvider } from '@makaio/kernel/providers';
import {
  bootMakaioRuntimeCore,
  normalizeNodeHostCapabilities,
  resolveMakaioHome,
  type MakaioRuntime,
} from '@makaio/runtime-node';
import {
  FilesystemDescriptorDiscovery,
  MergedDescriptorDiscovery,
  type DiscoveredExtension,
  type ExtensionDiscovery,
} from '@makaio/runtime-node/extension-discovery';

const moduleRequire = createRequire(import.meta.url);

const bundledRuntimePackages = [
  '@makaio/provider-alibaba',
  '@makaio/provider-anthropic',
  '@makaio/provider-github-copilot',
  '@makaio/provider-google',
  '@makaio/provider-kimi',
  '@makaio/provider-nanogpt',
  '@makaio/provider-opencode-go',
  '@makaio/provider-openai',
  '@makaio/provider-openai-codex',
  '@makaio/provider-openrouter',
  '@makaio/provider-qwen-acp',
  '@makaio/provider-z-ai',
  '@makaio/adapter-anthropic-sdk',
  '@makaio/adapter-claude-agent-sdk',
  '@makaio/adapter-claude-code-cli',
  '@makaio/adapter-codex-app-server',
  '@makaio/adapter-gemini-sdk',
  '@makaio/adapter-github-copilot-sdk',
  '@makaio/adapter-openai-node',
  '@makaio/adapter-pi-sdk',
  '@makaio/adapter-qwen-acp',
  '@makaio/extension-filesystem',
  '@makaio/extension-shell',
  '@makaio/extension-subagent',
] as const;

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

/** Current boot promise — set while boot is in progress or completed. */
let bootPromise: Promise<MakaioRuntime> | null = null;

/**
 * In-flight shutdown promise — set while a shutdown is executing.
 *
 * `ensureRuntime` awaits this before starting a new boot so that a new
 * runtime is never booted while the previous one is still tearing down.
 */
let shutdownPromise: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

class RuntimePackageDescriptorDiscovery implements ExtensionDiscovery {
  /**
   * @param packageNames - Runtime packages whose descriptor.json files should be loaded.
   */
  public constructor(private readonly packageNames: readonly string[]) {}

  /**
   * Resolve and parse descriptor.json from each bundled runtime package.
   * @returns Discovered extension descriptors for package-carried runtime capabilities.
   */
  public async discover(): Promise<DiscoveredExtension[]> {
    const discovered: DiscoveredExtension[] = [];
    for (const packageName of this.packageNames) {
      const packageRoot = resolvePackageRoot(packageName);
      if (packageRoot === undefined) {
        console.warn(`[agent-sdk/runtime] Unable to resolve bundled runtime package ${packageName}`);
        continue;
      }

      const descriptorPath = path.join(packageRoot, 'descriptor.json');
      try {
        const descriptor = parseExtensionDescriptor(JSON.parse(await fs.readFile(descriptorPath, 'utf8')));
        discovered.push({
          descriptor,
          extensionPath: packageRoot,
          source: 'local',
        });
      } catch (error) {
        console.warn(
          `[agent-sdk/runtime] Skipping bundled runtime package ${packageName}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    return discovered;
  }
}

/**
 * Resolve a package root even when its main export points at an unbuilt dist file.
 * @param packageName - Package specifier to resolve.
 * @returns Absolute package root path, or `undefined` when the package cannot be resolved.
 */
function resolvePackageRoot(packageName: string): string | undefined {
  const packageJsonPath = tryResolve(`${packageName}/package.json`);
  if (packageJsonPath !== undefined) {
    return path.dirname(packageJsonPath);
  }

  const entryPath = tryResolve(packageName);
  return entryPath === undefined ? undefined : findPackageRoot(path.dirname(entryPath));
}

/**
 * Resolve a module specifier without throwing.
 * @param specifier - Module specifier to resolve.
 * @returns Resolved path, or `undefined` when resolution fails.
 */
function tryResolve(specifier: string): string | undefined {
  try {
    return moduleRequire.resolve(specifier);
  } catch {
    return undefined;
  }
}

/**
 * Walk up from a resolved entrypoint to the owning package directory.
 * @param startDir - Directory containing the resolved package entrypoint.
 * @returns Package root path, or `undefined` if no package.json is found.
 */
function findPackageRoot(startDir: string): string | undefined {
  let current = startDir;
  while (true) {
    try {
      moduleRequire.resolve(path.join(current, 'package.json'));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

/**
 * Create descriptor discovery for the embedded runtime.
 * @returns Bundled runtime package discovery layered before filesystem discovery.
 */
function createRuntimeDiscovery(): ExtensionDiscovery {
  const makaioHome = resolveMakaioHome();
  return new MergedDescriptorDiscovery([
    new RuntimePackageDescriptorDiscovery(bundledRuntimePackages),
    new FilesystemDescriptorDiscovery(undefined, {
      extensionsDir: path.join(makaioHome, 'extensions'),
      nodeModulesDir: path.join(makaioHome, 'node_modules'),
    }),
  ]);
}

/**
 * Create and boot a new embedded runtime instance.
 *
 * Uses a {@link NoTransportProvider} (no HTTP/WebSocket server).
 * The package manager service is disabled because the extension set is fixed
 * at process startup time and Yarn Berry is not needed in-process.
 * @returns Resolved {@link MakaioRuntime} handle.
 */
const createRuntime = (): Promise<MakaioRuntime> =>
  bootMakaioRuntimeCore(new NoTransportProvider(), 0, '127.0.0.1', {
    hostCapabilities: normalizeNodeHostCapabilities(),
    enablePackageManager: false,
    discovery: createRuntimeDiscovery(),
    surface: 'headless',
  });

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the embedded runtime is booted and return the {@link MakaioBus}
 * singleton.
 *
 * The first call starts the runtime; subsequent calls return immediately.
 * The promise is shared so concurrent calls all wait on the same boot
 * sequence rather than starting multiple runtimes.
 *
 * If a shutdown is in progress this call waits for it to complete before
 * starting a new boot, preventing a second runtime from being spawned
 * while teardown is still running.
 * @returns The global {@link MakaioBus} singleton.
 */
export const ensureRuntime = async (): Promise<typeof MakaioBus> => {
  // Serialize against any in-progress shutdown so we never boot a new
  // runtime while the previous one is still tearing down.
  if (shutdownPromise !== null) {
    await shutdownPromise;
  }

  if (bootPromise === null) {
    bootPromise = createRuntime();
  }

  // Capture the promise identity so the catch handler only clears the
  // entry it created, not a replacement set by a concurrent call.
  const currentPromise = bootPromise;

  // Propagate boot errors to the caller without caching the failure:
  // a failed boot clears the promise so the next call retries.
  try {
    await currentPromise;
  } catch (err) {
    if (bootPromise === currentPromise) {
      bootPromise = null;
    }
    throw err;
  }

  return MakaioBus;
};

/**
 * Shut down the embedded runtime if it was started.
 *
 * Safe to call when no runtime was ever booted.  After shutdown, the next
 * call to {@link ensureRuntime} will start a fresh instance.
 *
 * Concurrent calls to {@link ensureRuntime} that arrive while shutdown is
 * in progress will wait for shutdown to finish before starting a new boot,
 * ensuring the two runtimes never overlap.
 * Concurrent shutdown callers join the same teardown promise.
 */
export const shutdownRuntime = async (): Promise<void> => {
  if (shutdownPromise !== null) {
    await shutdownPromise;
    return;
  }

  if (bootPromise === null) return;

  const runtimePromise = bootPromise;
  bootPromise = null;

  shutdownPromise = (async () => {
    try {
      const runtime = await runtimePromise;
      await runtime.shutdown();
    } catch {
      // Boot had already failed — nothing to shut down.
    } finally {
      shutdownPromise = null;
    }
  })();

  await shutdownPromise;
};
