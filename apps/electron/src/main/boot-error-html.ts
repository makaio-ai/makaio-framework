/**
 * Pure HTML builder for Electron boot error windows.
 *
 * Kept separate from `boot-error.ts` so unit tests can exercise escaping and
 * layout without importing Electron's native runtime package.
 */

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
