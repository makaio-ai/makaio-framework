import type { IMakaioBus } from '@makaio/bus-core';

/**
 * Render the interactive Ink TUI for account-manager.
 *
 * Dynamically imports the existing `<App>` component to avoid loading
 * Ink and React for non-interactive CLI subcommands.
 * @param bus - Connected bus instance.
 */
export async function renderApp(bus: IMakaioBus): Promise<void> {
  const { render } = await import('ink');
  const React = await import('react');
  const { App } = await import('../tui/app.js');
  const instance = render(React.createElement(App, { bus }));
  await instance.waitUntilExit();
}
