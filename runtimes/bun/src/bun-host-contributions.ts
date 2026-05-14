import type { BunRouteGraphFetch } from './bun-route-graph-fetch.js';
import type { BunWebSocketHandler } from './bus-server-transport.js';

/** Bun-native host hooks exposed by extensions that need HTTP/WebSocket routing. */
export interface BunHostContribution {
  /** Wrap the host fetch handler with extension-owned routing. */
  readonly createFetch?: (next: BunRouteGraphFetch) => BunRouteGraphFetch;
  /** Wrap the host WebSocket handler with extension-owned routing. */
  readonly createWebSocketHandler?: (next: BunWebSocketHandler) => BunWebSocketHandler;
}

/** Extension package shape that carries Bun host hooks. */
export interface BunHostExtensionPackage {
  /** Extension package name. */
  readonly name: string;
  /** Human-readable extension package name. */
  readonly displayName: string;
  /** Extension package version. */
  readonly version?: string;
  /** Bun-native host hooks consumed by Bun composition roots. */
  readonly bun: BunHostContribution;
}

/** Minimal active-extension iterator exposed by ExtensionCoordinator. */
export interface ActiveBunHostExtensionIterator {
  /**
   * Iterate active extension packages after coordinator startup.
   * @param callback - Receives active package metadata.
   */
  forEachActiveExtension(
    callback: (name: string, pkg: Pick<BunHostExtensionPackage, 'name' | 'displayName'>) => void,
  ): void;
}

/** Mutable router passed to `Bun.serve` before runtime boot finishes. */
export interface BunHostRouter {
  /** Stable fetch delegate for `Bun.serve`. */
  readonly fetch: BunRouteGraphFetch;
  /** Stable WebSocket delegate for `Bun.serve`. */
  readonly websocket: BunWebSocketHandler;
  /**
   * Activate Bun host hooks from packages that survived extension lifecycle gates.
   * @param packages - Active extension packages with optional Bun hooks.
   */
  activate(packages: readonly BunHostExtensionPackage[]): void;
}

/**
 * Create a stable Bun router whose delegates can be activated after extension boot.
 *
 * The force point is lifecycle order: `Bun.serve` needs stable callbacks before
 * the runtime starts, while extension host hooks must only affect routing after
 * the coordinator has accepted the package as active.
 * @param baseFetch - Base route-graph fetch handler.
 * @param baseWebSocket - Base bus WebSocket handler.
 * @returns Mutable router with stable `Bun.serve` delegates.
 */
export function createBunHostRouter(baseFetch: BunRouteGraphFetch, baseWebSocket: BunWebSocketHandler): BunHostRouter {
  let activeFetch = baseFetch;
  let activeWebSocket = baseWebSocket;

  return {
    fetch(request, server) {
      return activeFetch(request, server);
    },
    websocket: {
      binaryType: baseWebSocket.binaryType,
      open(ws) {
        activeWebSocket.open(ws);
      },
      message(ws, message) {
        activeWebSocket.message(ws, message);
      },
      close(ws, code, reason) {
        activeWebSocket.close(ws, code, reason);
      },
    },
    activate(packages) {
      activeFetch = composeBunHostFetch(baseFetch, packages);
      activeWebSocket = composeBunHostWebSocket(baseWebSocket, packages);
    },
  };
}

/**
 * Collect Bun host packages from the coordinator's active extension snapshot.
 * @param coordinator - Active extension iterator captured during boot.
 * @returns Active packages with valid Bun host hooks.
 */
export function collectActiveBunHostPackages(
  coordinator: ActiveBunHostExtensionIterator,
): readonly BunHostExtensionPackage[] {
  const packages: BunHostExtensionPackage[] = [];
  coordinator.forEachActiveExtension((_name, pkg) => {
    if (isBunHostExtensionPackage(pkg)) {
      packages.push(pkg);
    }
  });
  return packages;
}

/**
 * Normalize a static extension module default into Bun host packages.
 * @param value - Extension package or package array.
 * @returns Packages with valid Bun host hooks.
 */
export function normalizeBunHostPackages(value: unknown): readonly BunHostExtensionPackage[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeBunHostPackages(item));
  }
  if (!isBunHostExtensionPackage(value)) {
    return [];
  }
  return [value];
}

/**
 * Compose Bun fetch host hooks in package order.
 * @param baseFetch - Base fetch handler.
 * @param packages - Packages with optional Bun hooks.
 * @returns Wrapped fetch handler.
 */
export function composeBunHostFetch(
  baseFetch: BunRouteGraphFetch,
  packages: readonly BunHostExtensionPackage[],
): BunRouteGraphFetch {
  return packages.reduce((fetch, pkg) => pkg.bun.createFetch?.(fetch) ?? fetch, baseFetch);
}

/**
 * Compose Bun WebSocket host hooks in package order.
 * @param baseHandler - Base WebSocket handler.
 * @param packages - Packages with optional Bun hooks.
 * @returns Wrapped WebSocket handler.
 */
export function composeBunHostWebSocket(
  baseHandler: BunWebSocketHandler,
  packages: readonly BunHostExtensionPackage[],
): BunWebSocketHandler {
  return packages.reduce((handler, pkg) => pkg.bun.createWebSocketHandler?.(handler) ?? handler, baseHandler);
}

/**
 * Check whether an extension package exposes a valid Bun host contribution.
 * @param value - Candidate extension package.
 * @returns Whether the value carries a usable Bun host contribution.
 */
function isBunHostExtensionPackage(value: unknown): value is BunHostExtensionPackage {
  if (!isRecord(value)) {
    return false;
  }
  const bun = value['bun'];
  return typeof value['name'] === 'string' && typeof value['displayName'] === 'string' && isBunHostContribution(bun);
}

/**
 * Check whether a value is a structurally valid Bun host contribution.
 * @param value - Candidate contribution value.
 * @returns Whether the value has only supported Bun host hook functions.
 */
function isBunHostContribution(value: unknown): value is BunHostContribution {
  if (!isRecord(value)) {
    return false;
  }
  const createFetch = value['createFetch'];
  const createWebSocketHandler = value['createWebSocketHandler'];
  return (
    (createFetch === undefined || typeof createFetch === 'function') &&
    (createWebSocketHandler === undefined || typeof createWebSocketHandler === 'function')
  );
}

/**
 * Check whether a value can be read as an object record.
 * @param value - Candidate value.
 * @returns Whether the value is a non-null object.
 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}
