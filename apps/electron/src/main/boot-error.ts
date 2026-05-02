/**
 * Boot error window for fatal startup failures.
 *
 * When `bootMakaioRuntime()` throws, the main process shows a minimal error
 * window via a data URL — no web server, no bus, no framework dependencies.
 *
 * Note: The top-level `electron` import means this module can only be loaded
 * in Electron's main process or in test environments that mock `electron`
 * (vitest does this automatically). `buildBootErrorHtml` is a pure function
 * but shares this module for co-location — extracting it would add a file
 * solely to satisfy a theoretical import constraint.
 * @packageDocumentation
 */

import { app, BrowserWindow } from 'electron';

/**
 * Escape HTML special characters to prevent injection in the error window.
 * Handles `&`, `<`, `>`, `"`, and `'`.
 * @param text - Raw text to escape.
 * @returns HTML-safe string.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build the HTML content for the boot error window.
 *
 * Pure function — testable without Electron runtime. Returns a complete HTML
 * document string with the error message and a quit button.
 * @param error - The boot error (Error instance or unknown value).
 * @returns Complete HTML document string.
 */
export function buildBootErrorHtml(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error && error.stack ? error.stack : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Makaio — Startup Error</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0d0f12; color: #e0e0e0; padding: 32px;
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; min-height: 100vh; margin: 0;
    }
    h1 { color: #ff6b6b; font-size: 20px; margin-bottom: 12px; }
    .message { font-size: 14px; margin-bottom: 16px; max-width: 600px;
      word-break: break-word; text-align: center; }
    .stack { font-size: 11px; color: #888; white-space: pre-wrap;
      max-width: 600px; max-height: 200px; overflow: auto;
      background: #1a1d23; padding: 12px; border-radius: 6px;
      margin-bottom: 24px; }
    button { background: #ff6b6b; color: #fff; border: none;
      padding: 8px 24px; border-radius: 4px; cursor: pointer;
      font-size: 14px; }
    button:hover { background: #ff5252; }
  </style>
</head>
<body>
  <h1>Makaio failed to start</h1>
  <div class="message">${escapeHtml(message)}</div>
  ${stack ? `<pre class="stack">${escapeHtml(stack)}</pre>` : ''}
  <button onclick="window.close()">Quit</button>
</body>
</html>`;
}

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
