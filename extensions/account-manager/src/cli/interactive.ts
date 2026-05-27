import type { IMakaioBus } from '@makaio/bus-core';

/**
 * Render the interactive Ink TUI for account-manager.
 *
 * Dynamically imports the existing `<App>` component to avoid loading
 * Ink and React for non-interactive CLI subcommands.
 * @param bus - Connected bus instance.
 * @param signal - Abort signal for process cancellation.
 */
export async function renderApp(bus: IMakaioBus, signal: AbortSignal): Promise<void> {
  const { render } = await import('ink');
  const React = await import('react');
  const { App } = await import('../tui/app.js');
  const instance = render(React.createElement(App, { bus }));
  const onAbort = (): void => instance.unmount();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) onAbort();
    await instance.waitUntilExit();
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
