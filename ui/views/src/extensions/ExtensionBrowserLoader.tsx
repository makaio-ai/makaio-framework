/**
 * ExtensionBrowserLoader — discovers and loads all extension browser entry points.
 *
 * States:
 * - `loading` — waiting for runtime ready and fetching/importing extensions
 * - `ready`   — extensions loaded and registered (shell may or may not have been provided)
 * - `empty`   — no extensions have browser entry points at all
 * - `error`   — extension discovery/import failed before any shell was available
 * @packageDocumentation
 */

import { useState, useEffect, useRef, type ComponentType, type JSX } from 'react';
import { useBus, loadExtensionBrowserContributions } from '@makaio/ui-hooks';
import {
  getRegisteredExtensionBrowserFactory,
  unregisterExtensionBrowserFactory,
  registerExtensionUI,
  resolveExtensionBrowserFactory,
  runCleanupsInReverse,
  createRuntimeReadyWaiter,
  SHELL_BG_COLOR,
  SHELL_FONT_FAMILY,
  SHELL_TEXT_COLOR,
} from '@makaio/ui-kernel';
import type { ExtensionBrowserContribution, ExtensionBrowserFactory, ShellProps } from '@makaio/ui-kernel';
import { EmptyStateUI } from './EmptyStateUI.js';
import { FrameworkShell } from '../shell/FrameworkShell.js';

// ---------------------------------------------------------------------------
// Boot splash (inline — shell-level, must not depend on theme/CSS pipeline)
// ---------------------------------------------------------------------------

/**
 * Minimal loading indicator shown while the runtime is booting and extensions
 * are being imported.  Inline styles intentional — same rationale as EmptyStateUI.
 * @returns Shell-level loading splash.
 */
function BootSplash(): JSX.Element {
  return (
    <div
      data-component="BootSplash"
      style={{
        alignItems: 'center',
        backgroundColor: SHELL_BG_COLOR,
        color: SHELL_TEXT_COLOR,
        display: 'flex',
        fontFamily: SHELL_FONT_FAMILY,
        height: '100vh',
        justifyContent: 'center',
      }}
    >
      <p style={{ opacity: 0.5 }}>Loading...</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExtensionBrowserLoader
// ---------------------------------------------------------------------------

/** Discriminated loading state for the loader component. */
type LoaderState = 'loading' | 'ready' | 'empty' | 'error';

/**
 * Discovers, loads, and activates all extension browser entry points.
 *
 * On mount it waits for `kernel.isReady` (or the `kernel.ready` event if
 * not yet ready), then delegates browser discovery/import/registration to
 * {@link loadExtensionBrowserContributions}. This component owns the React
 * state machine and cleanup wiring around that shared loader. If no
 * contribution provides a `shell`, the framework-owned fallback shell is
 * rendered as the root workspace chrome.
 *
 * Uses the run-ID pattern instead of a `mounted` flag to remain safe under
 * React StrictMode double-invocation (see lessons-learned.md).
 * @returns Resolved extension shell or a framework fallback.
 */
export function ExtensionBrowserLoader(): JSX.Element {
  const bus = useBus();
  const runIdRef = useRef(0);
  const [state, setState] = useState<LoaderState>('loading');
  const [Shell, setShell] = useState<ComponentType<ShellProps> | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    setState('loading');
    setShell(null);
    setErrorMessage(null);
    const currentRunId = ++runIdRef.current;
    const isCurrentRun = (): boolean => runIdRef.current === currentRunId;
    const cleanups: Array<() => void> = [];

    /**
     * Loads all active browser extensions and registers their contributions.
     * Awaits runtime readiness before querying the extension list.
     *
     * Pre-loop bus queries are fatal — any failure transitions to `error`.
     * Per-extension import errors are isolated so a single bad extension
     * does not block the remaining ones or leave registered contributions
     * without their cleanup callbacks.
     */
    async function load(): Promise<void> {
      try {
        const result = await loadExtensionBrowserContributions<
          ExtensionBrowserContribution,
          ShellProps,
          ExtensionBrowserFactory
        >({
          bus,
          getRegisteredFactory: getRegisteredExtensionBrowserFactory,
          isCurrentRun,
          registerExtensionUI,
          resolveFactory: resolveExtensionBrowserFactory,
          unregisterFactory: unregisterExtensionBrowserFactory,
          waitForRuntimeReady: createRuntimeReadyWaiter,
        });

        if (!isCurrentRun()) {
          return;
        }

        cleanups.push(...result.cleanups);
        setShell(() => result.shell);
        setErrorMessage(result.errorMessage);
        setState(result.state);
      } catch (error) {
        if (!isCurrentRun()) {
          return;
        }

        const message = error instanceof Error ? error.message : 'Check the console for the failing extension.';
        console.error('[ExtensionBrowserLoader] Unexpected browser loader failure', error);
        setErrorMessage(message);
        setState('error');
      }
    }

    void load();

    // Each effect invocation creates a fresh `cleanups` array in its closure.
    // The run-ID pattern ensures stale closures bail out at every async
    // checkpoint, so this teardown is the only code that touches `cleanups`
    // after the effect returns — no double-execution risk under StrictMode.
    return () => {
      ++runIdRef.current; // Invalidate any in-flight async work
      runCleanupsInReverse(cleanups, '[ExtensionBrowserLoader]');
    };
  }, [bus]);

  if (state === 'loading') return <BootSplash />;
  if (state === 'error') {
    return (
      <EmptyStateUI
        detail={errorMessage ?? 'Check the console for the failing extension.'}
        message="Workspace chrome could not be assembled from the available extensions."
        title="Extension Load Error"
      />
    );
  }
  if (state === 'empty' || !Shell) return <FrameworkShell bus={bus} />;

  return <Shell bus={bus} />;
}
