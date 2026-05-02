import { pathToFileURL } from 'node:url';
import { SHARED_BROWSER_EXTERNALS } from '@makaio/build-tooling/browser-shared-externals';
import type { ExtensionEntrypoints } from '@makaio/contracts';
import {
  entrypointStem,
  isCliContributionLike,
  isMakaioExtensionLike,
} from '@makaio/runtime-node/extension-validation';
import { verifyBrowserModuleGraph } from './extension-verify-browser.js';
import {
  failVerification,
  recordCheck,
  type ExtensionVerifyDiagnostic,
  type ExtensionVerifyState,
} from './extension-verify-model.js';

interface ImportedDefaultModule {
  readonly default: unknown;
}

interface ImportedRuntimeEntrypoint {
  /** Stem string for diagnostics (surface name or custom stem). */
  readonly stem: string;
  readonly resolvedPath: string;
  readonly mod: ImportedDefaultModule;
}

/**
 * Verify the server entrypoint exports a MakaioExtension-like default.
 * @param state - Mutable verification state.
 * @param entrypointValue - Server entrypoint declaration from the descriptor.
 * @param resolvedPath - Absolute server entrypoint path.
 * @returns Resolves when verification passes; throws on failure.
 */
export async function verifyServerEntrypoint(
  state: ExtensionVerifyState,
  entrypointValue: true | string | undefined,
  resolvedPath: string | undefined,
): Promise<void> {
  const importedEntrypoint = await importRuntimeEntrypoint(state, 'server', entrypointValue, resolvedPath);
  if (!importedEntrypoint) {
    return;
  }
  const { stem, resolvedPath: absolutePath, mod } = importedEntrypoint;

  if (!isMakaioExtensionLike(mod.default)) {
    return failRuntimeCheck(state, 'server', stem, absolutePath, {
      code: 'server.invalid-default-export',
      message: `Server entrypoint default export is not a valid MakaioExtension: ${stem}`,
      surface: 'server',
      entrypoint: stem,
      filePath: absolutePath,
    });
  }

  recordRuntimePass(state, 'server', stem, absolutePath);
}

/**
 * Verify the browser entrypoint is loadable ESM and uses only supported bare imports.
 * @param state - Mutable verification state.
 * @param entrypointValue - Browser entrypoint declaration from the descriptor.
 * @param resolvedPath - Absolute browser entrypoint path.
 */
export async function verifyBrowserEntrypoint(
  state: ExtensionVerifyState,
  entrypointValue: true | string | undefined,
  resolvedPath: string | undefined,
): Promise<void> {
  if (!entrypointValue || !resolvedPath) {
    recordRuntimeSkip(state, 'browser');
    return;
  }

  const stem = entrypointStem('browser', entrypointValue);

  const browserGraphFailure = await verifyBrowserModuleGraph(resolvedPath);
  if (browserGraphFailure?.code === 'browser.static-root-escape') {
    failRuntimeCheck(state, 'browser', stem, resolvedPath, {
      code: 'browser.static-root-escape',
      message: `Browser entrypoint reaches outside the static root: ${browserGraphFailure.cause}`,
      surface: 'browser',
      entrypoint: stem,
      filePath: resolvedPath,
      cause: browserGraphFailure.cause,
    });
  }

  if (browserGraphFailure?.code === 'browser.unsupported-bare-import') {
    failRuntimeCheck(state, 'browser', stem, resolvedPath, {
      code: 'browser.unsupported-bare-import',
      message:
        `Browser entrypoint contains unsupported bare imports: ${browserGraphFailure.bareImports.join(', ')}. ` +
        `Supported browser externals: ${SHARED_BROWSER_EXTERNALS.join(', ')}.`,
      surface: 'browser',
      entrypoint: stem,
      filePath: resolvedPath,
      bareImports: browserGraphFailure.bareImports,
    });
  }

  if (browserGraphFailure) {
    failRuntimeCheck(state, 'browser', stem, resolvedPath, {
      code: 'browser.invalid-esm',
      message: `Browser entrypoint is not parseable/loadable ESM: ${browserGraphFailure.cause}`,
      surface: 'browser',
      entrypoint: stem,
      filePath: resolvedPath,
      cause: browserGraphFailure.cause,
    });
  }

  recordRuntimePass(state, 'browser', stem, resolvedPath);
}

/**
 * Verify the CLI entrypoint exports a CliContribution-like default.
 * @param state - Mutable verification state.
 * @param entrypointValue - CLI entrypoint declaration from the descriptor.
 * @param resolvedPath - Absolute CLI entrypoint path.
 * @returns Resolves when verification passes; throws on failure.
 */
export async function verifyCliEntrypoint(
  state: ExtensionVerifyState,
  entrypointValue: true | string | undefined,
  resolvedPath: string | undefined,
): Promise<void> {
  const importedEntrypoint = await importRuntimeEntrypoint(state, 'cli', entrypointValue, resolvedPath);
  if (!importedEntrypoint) {
    return;
  }
  const { stem, resolvedPath: absolutePath, mod } = importedEntrypoint;

  if (!isCliContributionLike(mod.default)) {
    return failRuntimeCheck(state, 'cli', stem, absolutePath, {
      code: 'cli.invalid-default-export',
      message: `CLI entrypoint default export is not a valid CliContribution: ${stem}`,
      surface: 'cli',
      entrypoint: stem,
      filePath: absolutePath,
    });
  }

  recordRuntimePass(state, 'cli', stem, absolutePath);
}

/**
 * Import a runtime entrypoint when it is declared.
 * @param state - Mutable verification state.
 * @param surface - Declared runtime surface.
 * @param entrypointValue - Entrypoint declaration from `descriptor.json`.
 * @param resolvedPath - Absolute filesystem path.
 * @returns Imported module namespace or `undefined` when the surface is absent.
 */
async function importRuntimeEntrypoint(
  state: ExtensionVerifyState,
  surface: Extract<keyof ExtensionEntrypoints, 'server' | 'cli'>,
  entrypointValue: true | string | undefined,
  resolvedPath: string | undefined,
): Promise<ImportedRuntimeEntrypoint | undefined> {
  if (!entrypointValue || !resolvedPath) {
    recordRuntimeSkip(state, surface);
    return undefined;
  }

  const stem = entrypointStem(surface, entrypointValue);

  try {
    // Node caches dynamic import() by URL, but verifyExtensionWorkspace runs once
    // per CLI invocation and tests use unique temp paths, so cache hits are impossible.
    return {
      stem,
      resolvedPath,
      mod: (await import(pathToFileURL(resolvedPath).href)) as ImportedDefaultModule,
    };
  } catch (error) {
    return failRuntimeCheck(state, surface, stem, resolvedPath, {
      code: 'entrypoint.import-failed',
      message: `Failed to import ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
      surface,
      entrypoint: stem,
      filePath: resolvedPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Record a skipped runtime surface.
 * @param state - Mutable verification state.
 * @param surface - Declared runtime surface.
 */
function recordRuntimeSkip(state: ExtensionVerifyState, surface: keyof ExtensionEntrypoints): void {
  recordCheck(state, {
    check: 'runtime',
    status: 'skipped',
    surface,
    diagnostics: [],
  });
}

/**
 * Record a passed runtime surface.
 * @param state - Mutable verification state.
 * @param surface - Declared runtime surface.
 * @param entrypoint - Entrypoint stem for diagnostics.
 * @param filePath - Absolute runtime entrypoint path.
 */
function recordRuntimePass(
  state: ExtensionVerifyState,
  surface: keyof ExtensionEntrypoints,
  entrypoint: string,
  filePath: string,
): void {
  recordCheck(state, {
    check: 'runtime',
    status: 'passed',
    surface,
    entrypoint,
    filePath,
    diagnostics: [],
  });
}

/**
 * Record a failed runtime check and throw a typed verification error.
 * @param state - Mutable verification state.
 * @param surface - Declared runtime surface.
 * @param entrypoint - Entrypoint stem for diagnostics.
 * @param filePath - Absolute runtime entrypoint path.
 * @param diagnostic - Structured runtime diagnostic.
 * @returns Never.
 */
function failRuntimeCheck(
  state: ExtensionVerifyState,
  surface: keyof ExtensionEntrypoints,
  entrypoint: string,
  filePath: string,
  diagnostic: ExtensionVerifyDiagnostic,
): never {
  return failVerification(state, {
    check: 'runtime',
    status: 'failed',
    surface,
    entrypoint,
    filePath,
    diagnostics: [diagnostic],
  });
}
