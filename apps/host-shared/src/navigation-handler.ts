import type { IMakaioBus } from '@makaio/bus-core';
import type { WindowManagerState } from './window-session.js';
import { UiSubjects } from '@makaio/ui-kernel';
import type { WindowRegistry, WindowRegistration } from '@makaio/kernel';

/**
 * Request payload for creating a new window via the navigation handler.
 */
export interface WindowCreateRequest {
  /** Qualified window registration ID: `{packageName}:{windowId}`. */
  readonly registrationId: string;
  /** Context parameters to associate with the new window. */
  readonly params?: Record<string, string>;
}

/**
 * Assert that caller-supplied window params do not collide with keys reserved
 * by the host's bootstrap contract (e.g. `app`, `window`, `busUrl`).
 * @param params - Caller-supplied context params from {@link WindowCreateRequest}.
 * @param reservedKeys - Host-specific set of reserved query-param names.
 * @param hostLabel - Human-readable host name for the error message.
 */
export function assertNoReservedWindowParams(
  params: Readonly<Record<string, string>>,
  reservedKeys: ReadonlySet<string>,
  hostLabel: string,
): void {
  for (const key of Object.keys(params)) {
    if (reservedKeys.has(key)) {
      throw new Error(`Window param "${key}" is reserved by the ${hostLabel} bootstrap contract.`);
    }
  }
}

/**
 * Resolved navigation target returned by {@link resolveNavigation}.
 */
export interface ResolvedNavigation {
  /** Qualified window registration ID: `{packageName}:{windowId}`. */
  readonly qualifiedId: string;
  /**
   * Additional parameters extracted from the URL (e.g. `projectId`,
   * `sessionId`). May be empty but is never `null`.
   */
  readonly params: Readonly<Record<string, string>>;
}

/**
 * Resolve a navigation URL to a window registration using the window registry.
 *
 * Routing rules (in priority order):
 * 1. `/apps/:packageName/:windowId` → exact package-scoped match.
 * 2. `/apps/:packageName` → resolve only when the package owns exactly one
 *    registered window. Ambiguous package routes must be qualified explicitly.
 * 3. `/:packageName::windowId` → exact qualified window match.
 * 4. `/:windowId` or `/:windowId/:param` → match against registered window IDs
 *    (the non-qualified part). Extracts path-embedded parameters (projectId for
 *    `/project/:id`, sessionId for `/chat/:id`). Ambiguous generic window IDs
 *    must be qualified explicitly.
 * 5. Unrecognised URLs → `null` (handler should call `ctx.next()`).
 *
 * Query strings and trailing slashes are stripped before matching.
 * @param url - Navigation URL path, e.g. `/apps/my-ext.dashboard/main` or `/chat`
 * @param registry - Window registry populated from package manifests
 * @returns Resolved navigation target or `null` if no registration matches
 */
export function resolveNavigation(url: string, registry: WindowRegistry): ResolvedNavigation | null {
  // Normalise: strip query string, hash, and trailing slash
  const rawPath = url.split('#')[0].split('?')[0].replace(/\/$/, '') || '/';
  const queryString = url.includes('?') ? url.slice(url.indexOf('?') + 1).split('#')[0] : '';
  const segments = rawPath.split('/').filter(Boolean);

  // Extract query params for forwarding (projectId, sessionId, etc.)
  const params: Record<string, string> = {};
  if (queryString) {
    for (const [k, v] of new URLSearchParams(queryString)) {
      params[k] = v;
    }
  }

  const registrations = registry.list();

  const resolveUniqueMatch = (
    matches: ReadonlyArray<WindowRegistration>,
    resolvedParams: Readonly<Record<string, string>>,
  ): ResolvedNavigation | null => {
    if (matches.length !== 1) {
      return null;
    }
    return { qualifiedId: matches[0].qualifiedId, params: resolvedParams };
  };

  // 1. Package-based routes: /apps/:packageName
  if (segments[0] === 'apps' && segments[1]) {
    const packageName = segments[1];
    if (segments[2]) {
      const qualifiedMatch = registry.getByPackageWindow(packageName, segments[2]);
      if (qualifiedMatch) {
        return { qualifiedId: qualifiedMatch.qualifiedId, params };
      }
      return null;
    }
    return resolveUniqueMatch(
      registrations.filter((r) => r.packageName === packageName),
      params,
    );
  }

  // 2. Qualified window routes: /:packageName::windowId
  if (segments[0]?.includes(':')) {
    const qualifiedMatch = registry.get(segments[0]);
    if (qualifiedMatch) {
      return { qualifiedId: qualifiedMatch.qualifiedId, params };
    }
    return null;
  }

  // 3. Window-ID routes: /:windowId or /:windowId/:param
  if (segments.length >= 1) {
    const windowId = segments[0];
    const matches = registrations.filter((r) => r.windowId === windowId);

    if (matches.length > 0) {
      // Single-param invariant: all window manifests currently declare at
      // most one route parameter. Multi-param routing would need ordered
      // segment-to-param mapping here.
      if (segments[1] && matches[0]?.params?.length) {
        const paramName = matches[0].params[0].name;
        return resolveUniqueMatch(matches, { ...params, [paramName]: segments[1] });
      }
      return resolveUniqueMatch(matches, params);
    }
  }

  return null;
}

/**
 * Minimal window-manager seam consumed by the navigation handler.
 *
 * Declaring only the operations the handler actually needs keeps
 * `registerHostNavigationHandler` decoupled from the full `WindowManager`
 * class and makes the handler straightforward to test.
 */
interface INavigationWindowManager {
  /**
   * Returns a snapshot of all currently open windows.
   * @returns Array of window state snapshots
   */
  listWindows(): ReadonlyArray<WindowManagerState>;
  /**
   * Brings the specified window to the foreground.
   * @param windowId - Window ID to focus
   * @returns `true` if the window was found and focused
   */
  focusWindow(windowId: number): boolean;
}

/**
 * Dependencies injected into the host navigation handler.
 *
 * Separating these out keeps `registerHostNavigationHandler` testable without a
 * real desktop host process.
 */
interface NavigationHandlerDeps {
  /**
   * Creates a window and wires lifecycle events (opened, closed, tray).
   *
   * This is the module-level `createWindow` helper from `main.ts`, not
   * `windowManager.createWindow` directly. It owns all bus interaction around
   * window creation.
   * @param options - Window creation options (registrationId, params)
   * @returns The window ID of the created or focused window
   */
  createWindow: (options: WindowCreateRequest) => number;
  /** Window manager for querying and focusing existing windows. */
  windowManager: INavigationWindowManager;
  /** Window registry for resolving navigation URLs to registrations. */
  windowRegistry: WindowRegistry;
}

/**
 * Registers the host-side `ui.navigate` handler at priority 100.
 *
 * Intercepts `ui.navigate` requests, resolves the URL to a window registration
 * via {@link resolveNavigation}, and either focuses an existing matching window
 * or creates a new one. Unrecognised URLs fall through to lower-priority
 * handlers via `ctx.next()`.
 *
 * The handler is registered at priority 100 so it runs before the browser
 * app-shell handler (priority 10), which opens the URL in the browser.
 * @param bus - The MakaioBus instance to register on
 * @param deps - Window creation, management, and registry dependencies
 * @returns Cleanup function that unregisters the handler
 */
export function registerHostNavigationHandler(bus: IMakaioBus, deps: NavigationHandlerDeps): () => void {
  return bus.on(
    UiSubjects.navigate,
    (ctx) => {
      const resolved = resolveNavigation(ctx.payload.url, deps.windowRegistry);

      if (!resolved) {
        // Unrecognised URL — let lower-priority handlers deal with it.
        return ctx.next();
      }

      const { qualifiedId, params } = resolved;

      // Normalise empty params to undefined so the matching logic below treats
      // "no params" and "empty params object" identically.
      const resolvedParams = Object.keys(params).length > 0 ? params : undefined;

      // Check if a matching window is already open and focus it.
      // A request without params must only match a window that also has no params.
      // A request with params must match a window whose params contain the same
      // key-value pairs (extra keys on the window are allowed).
      const existing = deps.windowManager.listWindows().find((w) => {
        if (w.registrationId !== qualifiedId) return false;
        if (resolvedParams == null) return w.params == null || Object.keys(w.params).length === 0;
        return Object.entries(resolvedParams).every(([k, v]) => w.params?.[k] === v);
      });

      if (existing) {
        if (deps.windowManager.focusWindow(existing.windowId)) {
          ctx.setResult({ action: 'focused' });
          return;
        }
      }

      deps.createWindow({
        registrationId: qualifiedId,
        params: resolvedParams,
      });
      ctx.setResult({ action: 'opened' });
    },
    { priority: 100 },
  );
}
