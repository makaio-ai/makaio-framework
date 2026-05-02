/**
 * Browser-side navigation URL target derivation.
 * @packageDocumentation
 */

/**
 * Single-segment routes that map to named singleton windows.
 *
 * Unrecognised paths always open in a new window to avoid silently reusing
 * an existing window with unrelated content.
 */
const SINGLETON_ROUTES = new Set(['project-overview', 'control-center', 'agent-manager']);

/**
 * Maps a navigation URL to a `window.open` target name for browser singleton/reuse semantics.
 *
 * Used as a fallback when the bus RPC is unavailable. Under normal operation,
 * the bus handler handles everything.
 *
 * Routing rules:
 * - `/apps/:packageName` → `apps-{packageName}` (package-level singleton)
 * - `/project/:id` → `project-{id}`
 * - `/chat/:sessionId` → `chat-{sessionId}`
 * - `/chat` → `_blank` (always a new window)
 * - Single-segment static routes → that segment as a named target
 * - Everything else → `_blank`
 * @param url - Target URL path, e.g. '/apps/makaio.project-overview/main' or '/project/abc-123'
 * @returns Target name for `window.open()` — named targets reuse windows, '_blank' always opens new
 */
export function deriveBrowserTarget(url: string): string {
  const path = url.split('#')[0].split('?')[0].replace(/\/+$/, '') || '/';
  const segments = path.split('/').filter(Boolean);

  if (segments.length === 0) return '_blank';

  // Package-based routes: /apps/:packageName
  if (segments[0] === 'apps' && segments[1]) {
    return `apps-${segments[1]}`;
  }

  // Legacy parameterised routes
  if (segments[0] === 'project' && segments[1]) {
    return `project-${segments[1]}`;
  }

  if (segments[0] === 'chat') {
    return segments[1] ? `chat-${segments[1]}` : '_blank';
  }

  // Only known single-segment routes become named targets (singleton windows).
  if (segments.length === 1 && SINGLETON_ROUTES.has(segments[0])) {
    return segments[0];
  }

  return '_blank';
}
