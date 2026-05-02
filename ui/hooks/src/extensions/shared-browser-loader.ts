import type { IMakaioBus } from '@makaio/bus-core';
import { ExtensionSubjects, type ExtensionInfo } from '@makaio/kernel';
import type { ComponentType } from 'react';
import type { RuntimeReadyWaitResult, RuntimeReadyWaiter } from '@makaio/ui-kernel';
import { runCleanupsInReverse } from '@makaio/ui-kernel';

export type SharedLoaderState = 'loading' | 'ready' | 'empty' | 'error';

interface SharedShellContribution<TShellProps> {
  component: ComponentType<TShellProps>;
}

interface SharedExtensionBrowserContribution<TShellProps> {
  shell?: SharedShellContribution<TShellProps>;
  destroy?: () => void;
}

interface SharedFactoryResolution<TContribution> {
  kind: 'resolved' | 'invalid';
  factory?: (context: SharedBrowserFactoryContext) => TContribution | null | undefined;
  reason?: string;
}

interface SharedBrowserFactoryContext {
  bus: IMakaioBus;
}

type SingleExtensionLoadResult<TShellProps> =
  | {
      failed: boolean;
      kind: 'ok';
      shell: ComponentType<TShellProps> | null;
    }
  | { kind: 'aborted' };

export interface ExtensionBrowserLoadResult<TShellProps> {
  cleanups: Array<() => void>;
  errorMessage: string | null;
  shell: ComponentType<TShellProps> | null;
  state: Exclude<SharedLoaderState, 'loading'>;
}

export interface ExtensionBrowserLoadOptions<
  TContribution extends SharedExtensionBrowserContribution<TShellProps>,
  TShellProps,
  TFactory,
> {
  bus: IMakaioBus;
  getRegisteredFactory: (extensionName: string) => TFactory | undefined;
  importModule?: (entrypointPath: string) => Promise<{ default?: unknown }>;
  isCurrentRun: () => boolean;
  registerExtensionUI: (bus: IMakaioBus, extensionName: string, contribution: TContribution) => () => void;
  resolveFactory: (
    moduleDefault: unknown,
    registeredFactory: TFactory | undefined,
  ) => SharedFactoryResolution<TContribution>;
  unregisterFactory: (extensionName: string) => void;
  waitForRuntimeReady: (bus: IMakaioBus) => RuntimeReadyWaiter;
}

const NO_SHELL_ERROR_MESSAGE = 'One or more extensions failed to load before providing workspace chrome.';
const RUNTIME_TIMEOUT_ERROR_MESSAGE =
  'The Makaio runtime did not respond. The service may have failed to start — try restarting the application or check the logs for errors.';

/**
 * Import an extension browser bundle from its normalized path.
 * @param entrypointPath - Canonical extension browser entrypoint path.
 * @returns Imported module namespace.
 */
async function defaultImportModule(entrypointPath: string): Promise<{ default?: unknown }> {
  return import(/* @vite-ignore */ entrypointPath);
}

/**
 * Narrow a factory resolution to the resolved branch.
 * @param resolution - Factory resolution produced by the caller-owned resolver.
 * @returns `true` when the resolution contains a callable browser factory.
 */
function isResolvedFactory<TContribution>(resolution: SharedFactoryResolution<TContribution>): resolution is {
  kind: 'resolved';
  factory: (context: SharedBrowserFactoryContext) => TContribution | null | undefined;
} {
  return resolution.kind === 'resolved' && resolution.factory !== undefined;
}

/**
 * Keep only active extensions that declare a browser entrypoint.
 * @param extensions - All known runtime extensions.
 * @returns Extensions eligible for browser loading.
 */
function filterBrowserExtensions(extensions: ExtensionInfo[]): ExtensionInfo[] {
  return extensions.filter((extension) => extension.state === 'active' && extension.browser?.entrypoint);
}

/**
 * Build the internal aborted result used when a stale run is discarded.
 * @returns Empty-state result with no retained cleanups.
 */
function buildAbortedResult<TShellProps>(): ExtensionBrowserLoadResult<TShellProps> {
  return {
    cleanups: [],
    errorMessage: null,
    shell: null,
    state: 'empty',
  };
}

/**
 * Check whether the runtime wait ended due to cancellation.
 * @param waitResult - Result returned by the runtime readiness waiter.
 * @returns `true` when the current load should abort without updating UI state.
 */
function isAbortResult(waitResult: RuntimeReadyWaitResult): boolean {
  return waitResult === 'cancelled';
}

/**
 * Build a typed loader result.
 * @param cleanups - Teardowns retained for caller-owned cleanup.
 * @param state - Final non-loading loader state.
 * @param shell - Resolved shell component, if any.
 * @param errorMessage - Optional user-facing error detail.
 * @returns Structured loader result.
 */
function buildResult<TShellProps>(
  cleanups: Array<() => void>,
  state: Exclude<SharedLoaderState, 'loading'>,
  shell: ComponentType<TShellProps> | null,
  errorMessage: string | null,
): ExtensionBrowserLoadResult<TShellProps> {
  return {
    cleanups,
    errorMessage,
    shell,
    state,
  };
}

/**
 * Wait for runtime readiness and fetch active browser extensions.
 * @param options - Shared loader options.
 * @param cleanups - Teardown stack retained across the load.
 * @returns Browser extensions, an early terminal result, or an abort marker.
 */
async function resolveBrowserExtensions<
  TContribution extends SharedExtensionBrowserContribution<TShellProps>,
  TShellProps,
  TFactory,
>(
  options: ExtensionBrowserLoadOptions<TContribution, TShellProps, TFactory>,
  cleanups: Array<() => void>,
): Promise<
  | { browserExtensions: ExtensionInfo[]; kind: 'ok' }
  | { kind: 'aborted' }
  | { kind: 'result'; result: ExtensionBrowserLoadResult<TShellProps> }
> {
  const { bus, isCurrentRun, waitForRuntimeReady } = options;
  const runtimeReady = waitForRuntimeReady(bus);
  cleanups.push(runtimeReady.cleanup);
  const waitResult = await runtimeReady.ready;

  if (isAbortResult(waitResult)) {
    runCleanupsInReverse(cleanups, '[ExtensionBrowserLoader]');
    return { kind: 'aborted' };
  }

  if (waitResult === 'timeout') {
    return {
      kind: 'result',
      result: buildResult(cleanups, 'error', null, RUNTIME_TIMEOUT_ERROR_MESSAGE),
    };
  }

  if (!isCurrentRun()) {
    runCleanupsInReverse(cleanups, '[ExtensionBrowserLoader]');
    return { kind: 'aborted' };
  }

  const { extensions } = await bus.request(ExtensionSubjects.list, {});
  const browserExtensions = filterBrowserExtensions(extensions);

  if (browserExtensions.length === 0) {
    return {
      kind: 'result',
      result: buildResult(cleanups, 'empty', null, null),
    };
  }

  return { browserExtensions, kind: 'ok' };
}

/**
 * Validate an extension browser entrypoint before import.
 * @param extension - Extension being loaded.
 * @returns Normalized import path or `null` when the entrypoint is unsafe.
 */
function normalizeEntrypoint(extension: ExtensionInfo): string | null {
  const rawEntrypoint = extension.browser!.entrypoint;
  let normalizedEntrypoint: URL;

  try {
    normalizedEntrypoint = new URL(rawEntrypoint, globalThis.location.origin);
  } catch {
    console.warn(`[ExtensionBrowserLoader] Extension "${extension.name}" has malformed entrypoint "${rawEntrypoint}"`);
    return null;
  }

  if (
    normalizedEntrypoint.origin !== globalThis.location.origin ||
    !normalizedEntrypoint.pathname.startsWith('/extensions/')
  ) {
    console.warn(
      `[ExtensionBrowserLoader] Extension "${extension.name}" has unsafe entrypoint "${rawEntrypoint}" (must stay under /extensions/)`,
    );
    return null;
  }

  return normalizedEntrypoint.pathname;
}

/**
 * Load and register one browser extension contribution.
 * @param options - Shared loader options.
 * @param extension - Extension being loaded.
 * @param cleanups - Global teardown stack retained for caller cleanup.
 * @param resolvedShell - Previously resolved shell component, if any.
 * @returns Updated shell selection and failure status, or an abort marker.
 */
async function loadSingleExtension<
  TContribution extends SharedExtensionBrowserContribution<TShellProps>,
  TShellProps,
  TFactory,
>(
  options: ExtensionBrowserLoadOptions<TContribution, TShellProps, TFactory>,
  extension: ExtensionInfo,
  cleanups: Array<() => void>,
  resolvedShell: ComponentType<TShellProps> | null,
): Promise<SingleExtensionLoadResult<TShellProps>> {
  const {
    bus,
    getRegisteredFactory,
    importModule = defaultImportModule,
    isCurrentRun,
    registerExtensionUI,
    resolveFactory,
    unregisterFactory,
  } = options;
  const entrypointPath = normalizeEntrypoint(extension);

  if (entrypointPath === null) {
    return { failed: true, kind: 'ok', shell: resolvedShell };
  }

  // Register factory teardown before module evaluation so side-effect
  // registration is still cleaned up if the import throws mid-execution.
  const extensionCleanups: Array<() => void> = [() => unregisterFactory(extension.name)];

  try {
    const module = await importModule(entrypointPath);

    if (!isCurrentRun()) {
      runCleanupsInReverse(extensionCleanups, `[ExtensionBrowserLoader] ${extension.name}`);
      runCleanupsInReverse(cleanups, '[ExtensionBrowserLoader]');
      return { kind: 'aborted' };
    }

    const factoryResolution = resolveFactory(module.default, getRegisteredFactory(extension.name));

    if (!isResolvedFactory(factoryResolution)) {
      runCleanupsInReverse(extensionCleanups, `[ExtensionBrowserLoader] ${extension.name}`);
      console.warn(
        `[ExtensionBrowserLoader] Extension "${extension.name}" has invalid browser factory (${factoryResolution.reason ?? 'unknown resolution error'})`,
      );
      return { failed: true, kind: 'ok', shell: resolvedShell };
    }

    const contribution = factoryResolution.factory({ bus });

    if (!contribution || typeof contribution !== 'object') {
      runCleanupsInReverse(extensionCleanups, `[ExtensionBrowserLoader] ${extension.name}`);
      console.warn(
        `[ExtensionBrowserLoader] Extension "${extension.name}" factory returned invalid contribution (expected object, got ${contribution === null ? 'null' : typeof contribution})`,
      );
      return { failed: true, kind: 'ok', shell: resolvedShell };
    }

    if (contribution.destroy) {
      extensionCleanups.push(contribution.destroy);
    }

    extensionCleanups.push(registerExtensionUI(bus, extension.name, contribution));

    let nextShell = resolvedShell;

    if (contribution.shell) {
      if (nextShell !== null) {
        console.warn(
          `[ExtensionBrowserLoader] Extension "${extension.name}" replaces the previously registered shell (shell contributions are last-wins)`,
        );
      }
      nextShell = contribution.shell.component;
    }

    cleanups.push(...extensionCleanups);
    return { failed: false, kind: 'ok', shell: nextShell };
  } catch (error) {
    runCleanupsInReverse(extensionCleanups, `[ExtensionBrowserLoader] ${extension.name}`);
    console.error(`[ExtensionBrowserLoader] Failed to load extension "${extension.name}":`, error);
    return { failed: true, kind: 'ok', shell: resolvedShell };
  }
}

/**
 * Load and register browser extension contributions for a renderer surface.
 *
 * Centralizes the runtime wait, extension discovery, secure browser import,
 * contribution registration, and shell selection logic. Callers retain
 * ownership of local registries and registration adapters via the injected
 * callbacks so this seam removes orchestration duplication without collapsing
 * framework and host ownership boundaries.
 * @param options - Loader dependencies owned by the caller surface.
 * @returns Final loader state, selected shell, and teardown callbacks.
 */
export async function loadExtensionBrowserContributions<
  TContribution extends SharedExtensionBrowserContribution<TShellProps>,
  TShellProps,
  TFactory,
>(
  options: ExtensionBrowserLoadOptions<TContribution, TShellProps, TFactory>,
): Promise<ExtensionBrowserLoadResult<TShellProps>> {
  const cleanups: Array<() => void> = [];

  try {
    const extensionResolution = await resolveBrowserExtensions(options, cleanups);

    if (extensionResolution.kind === 'aborted') {
      return buildAbortedResult();
    }

    if (extensionResolution.kind === 'result') {
      return extensionResolution.result;
    }

    let failedExtensions = 0;
    let resolvedShell: ComponentType<TShellProps> | null = null;

    for (const extension of extensionResolution.browserExtensions) {
      const extensionLoad: SingleExtensionLoadResult<TShellProps> = await loadSingleExtension(
        options,
        extension,
        cleanups,
        resolvedShell,
      );

      if (extensionLoad.kind === 'aborted') {
        return buildAbortedResult();
      }

      resolvedShell = extensionLoad.shell;
      if (extensionLoad.failed) {
        failedExtensions += 1;
      }
    }

    if (!options.isCurrentRun()) {
      runCleanupsInReverse(cleanups, '[ExtensionBrowserLoader]');
      return buildAbortedResult();
    }

    if (resolvedShell !== null) {
      return buildResult(cleanups, 'ready', resolvedShell, null);
    }

    if (failedExtensions > 0) {
      return buildResult(cleanups, 'error', null, NO_SHELL_ERROR_MESSAGE);
    }

    return buildResult(cleanups, 'empty', null, null);
  } catch (error) {
    console.error('[ExtensionBrowserLoader] Failed to query extensions:', error);
    return buildResult(cleanups, 'error', null, error instanceof Error ? error.message : String(error));
  }
}
