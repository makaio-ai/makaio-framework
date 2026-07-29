/**
 * Node-hosted CLI detection for framework client discovery.
 */
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import * as path from 'node:path';
import type { IMakaioBus } from '@makaio/bus-core';
import { BaseService } from '@makaio/service-base';
import { CLIDetectionSubjects, type CLIDetectionResult } from '@makaio/services-core/cli-detection/namespace';
import { execa } from 'execa';

const CLI_TIMEOUT_MS = 5_000;
const CLI_FORCE_KILL_AFTER_MS = 1_000;

/** Resolve a binary name to the exact executable selected by the current PATH. */
export type ExecutablePathResolver = (binary: string) => Promise<string | undefined>;

/** Probe an executable and return its raw version output. */
export type ExecutableVersionProbe = (executablePath: string) => Promise<string>;

/**
 * Resolve the first executable matching a binary name in PATH order.
 * @param binary - Executable name to locate.
 * @param env - Environment containing PATH and optional Windows PATHEXT.
 * @param platform - Runtime platform controlling executable suffix lookup.
 * @returns Absolute executable path, or undefined when no candidate is executable.
 */
export async function resolveExecutablePath(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const searchPath = env[pathKey] ?? '';
  const windowsExtensions = (env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  const extensions =
    platform === 'win32' ? (path.extname(binary) === '' ? windowsExtensions : ['', ...windowsExtensions]) : [''];

  for (const rawDirectory of searchPath.split(path.delimiter)) {
    const unquotedDirectory = rawDirectory.replace(/^"|"$/gu, '');
    const directory = path.resolve(unquotedDirectory || process.cwd());
    for (const extension of extensions) {
      const candidate = path.join(directory, `${binary}${extension}`);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue in PATH order until an executable candidate is found.
      }
    }
  }
  return undefined;
}

/**
 * Execute an installed CLI's version probe with a bounded runtime.
 * @param executablePath - Absolute executable path selected from PATH.
 * @param timeoutMs - Maximum probe runtime before termination begins.
 * @param forceKillAfterDelayMs - Grace period before forced termination.
 * @returns Raw stdout emitted by `<executable> --version`.
 */
export async function probeExecutableVersion(
  executablePath: string,
  timeoutMs = CLI_TIMEOUT_MS,
  forceKillAfterDelayMs = CLI_FORCE_KILL_AFTER_MS,
): Promise<string> {
  // execa handles Windows command-shim argument escaping. Each probe also owns
  // TERM-to-KILL escalation, so an uncooperative executable cannot leave the
  // bus request pending indefinitely.
  const { stdout } = await execa(executablePath, ['--version'], {
    forceKillAfterDelay: forceKillAfterDelayMs,
    timeout: timeoutMs,
  });
  return stdout;
}

/**
 * Parse a semantic version from CLI output.
 * @param output - Raw stdout from the version probe.
 * @returns Parsed version string or `unknown`.
 */
function parseVersion(output: string): string {
  const match = output.match(/(\d+\.\d+\.\d+)/u);
  return match?.[1] ?? 'unknown';
}

/**
 * Detect a single CLI binary.
 * @param binary - Binary name to detect.
 * @param resolvePath - Executable-path resolver.
 * @param probeVersion - Executable version probe.
 * @returns Detection result for the requested binary.
 */
export async function detectCLI(
  binary: string,
  resolvePath: ExecutablePathResolver = resolveExecutablePath,
  probeVersion: ExecutableVersionProbe = probeExecutableVersion,
): Promise<CLIDetectionResult> {
  try {
    const executablePath = await resolvePath(binary);
    if (executablePath === undefined) {
      return { binary, found: false };
    }

    const output = await probeVersion(executablePath);
    if (output.length === 0) {
      return { binary, found: false };
    }

    return {
      binary,
      found: true,
      path: executablePath,
      version: parseVersion(output),
    };
  } catch {
    return { binary, found: false };
  }
}

/**
 * Detect multiple CLI binaries in parallel.
 * @param binaries - Binary names to detect.
 * @param resolvePath - Executable-path resolver shared across all probes.
 * @param probeVersion - Executable version probe shared across all probes.
 * @returns Detection results in request order.
 */
export async function detectCLIs(
  binaries: readonly string[],
  resolvePath: ExecutablePathResolver = resolveExecutablePath,
  probeVersion: ExecutableVersionProbe = probeExecutableVersion,
): Promise<CLIDetectionResult[]> {
  return Promise.all(binaries.map((binary) => detectCLI(binary, resolvePath, probeVersion)));
}

/** Bus service that handles required framework CLI detection requests. */
export class CliDetectionService extends BaseService {
  /**
   * @param bus - Runtime event bus.
   */
  public constructor(bus: IMakaioBus) {
    super(bus);
  }

  /** Register the CLI detection request handler. */
  protected onInit(): void {
    this.registerHandler(CLIDetectionSubjects.scan, async (ctx) => {
      const results = await detectCLIs(ctx.payload.binaries);
      ctx.setResult({ results });
    });
  }
}
