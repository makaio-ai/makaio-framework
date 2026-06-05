/**
 * Boot error window for fatal startup failures.
 *
 * When `bootMakaioRuntime()` throws, the main process shows a minimal error
 * window via a data URL — no web server, no bus, no framework dependencies.
 * @packageDocumentation
 */

import { app, BrowserWindow } from 'electron';
import { buildBootErrorHtml } from './boot-error-html.js';
export { buildBootErrorHtml } from './boot-error-html.js';

/**
 * Show a minimal error window when the runtime boot fails.
 *
 * Creates a small BrowserWindow that loads a data URL — no server needed.
 * The window's close event quits the app.
 * @param error - The boot error to display.
 */
export function showBootErrorWindow(error: unknown): void {
  console.error('[electron] Boot failed:', error);

  const html = buildBootErrorHtml(error);
  const encoded = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

  const win = new BrowserWindow({
    width: 500,
    height: 400,
    resizable: false,
    backgroundColor: '#0d0f12',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  void win.loadURL(encoded);
  win.on('closed', () => app.quit());
}
