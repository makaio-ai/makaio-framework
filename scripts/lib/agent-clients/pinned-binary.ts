/**
 * Disposable managed-binary preparation for the agent-client probe.
 *
 * The paid probe must execute the exact version pinned by the provider's
 * existing managed-install descriptor, never an ambient global executable.
 * @packageDocumentation
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createNodeClientBinaryStrategyDependencies } from '@makaio/runtime-node/client-binary-strategy-dependencies';
import { createStrategy } from '@makaio/subsystem-client';
import type { StrategyDependencies } from '@makaio/subsystem-client';
import { getManagedInstall, getPinnedVersion, getVersionCommand } from './manifests.js';
import type { ProviderId } from './types.js';
import { resolveExecutable } from './version-validation.js';

/** A prepared disposable executable and its required cleanup action. */
export interface PreparedProbeBinary {
  /** Absolute executable path inside the managed install artifact. */
  readonly executablePath: string;
  /** Removes the disposable managed install directory. */
  cleanup(): Promise<void>;
}

/**
 * Resolves a managed version command inside an install artifact.
 * @param installPath - Absolute managed artifact root.
 * @param executable - Platform-aware relative executable descriptor.
 * @returns Absolute executable path contained by the artifact root.
 */
export function resolveManagedExecutable(
  installPath: string,
  executable: string | { default: string; win32?: string; darwin?: string; linux?: string },
): string {
  const relativeExecutable = resolveExecutable(executable);
  if (path.isAbsolute(relativeExecutable)) {
    throw new Error(`Managed versionCommand executable must be relative; received "${relativeExecutable}"`);
  }
  const resolvedInstallPath = path.resolve(installPath);
  const executablePath = path.resolve(resolvedInstallPath, relativeExecutable);
  const relativePath = path.relative(resolvedInstallPath, executablePath);
  if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`Managed versionCommand executable escapes installPath: "${relativeExecutable}"`);
  }
  return executablePath;
}

/**
 * Installs one provider's exact managed pin into a disposable directory.
 * @param params - Provider and optional test-only strategy dependencies.
 * @returns The managed executable path and an idempotent cleanup action.
 */
export async function preparePinnedProbeBinary(params: {
  provider: ProviderId;
  strategyDependencies?: StrategyDependencies;
}): Promise<PreparedProbeBinary> {
  const { provider } = params;
  const installPath = await fs.mkdtemp(path.join(os.tmpdir(), `makaio-${provider}-probe-`));
  const strategyDependencies = params.strategyDependencies ?? createNodeClientBinaryStrategyDependencies();
  try {
    const pinnedVersion = getPinnedVersion(provider);
    const strategy = createStrategy(getManagedInstall(provider), strategyDependencies);
    if (!strategy) throw new Error(`Provider "${provider}" has no supported managed install strategy`);
    const artifact = await strategy.execute(pinnedVersion, installPath);
    if (artifact.version !== pinnedVersion) {
      throw new Error(
        `Managed artifact version "${artifact.version}" does not match pinned version "${pinnedVersion}"`,
      );
    }
    return {
      executablePath: resolveManagedExecutable(artifact.installPath, getVersionCommand(provider).executable),
      cleanup: async () => strategyDependencies.removeDirectory(installPath),
    };
  } catch (error) {
    await strategyDependencies.removeDirectory(installPath);
    throw error;
  }
}
