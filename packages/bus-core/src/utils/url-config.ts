/**
 * Bus URL configuration utilities.
 *
 * Provides consistent parsing of bus URL environment variables across
 * all consumers (Electron, Vite configs, etc.) with correct handling of:
 *
 * - Default localhost development URLs (explicit port 6252)
 * - User-provided production URLs (preserve protocol defaults like wss:// to 443)
 */

/** Default bus URL for local development */
const DEFAULT_BUS_URL = 'ws://localhost:6252/bus';

/**
 * Parsed bus URL configuration.
 */
export interface BusUrlConfig {
  /**
   * The full URL href for client connections.
   * For default localhost, includes explicit port.
   * For user-provided URLs, preserves original (protocol defaults intact).
   */
  href: string;

  /**
   * The port number for server binding.
   * - For default localhost: 6252
   * - For user-provided URLs with explicit port: that port
   * - For user-provided URLs without port: undefined (use protocol default)
   */
  port: number | undefined;

  /**
   * Whether this is the default localhost URL (no env var set).
   */
  isDefault: boolean;
}

/**
 * Parses the bus URL from environment variable with correct default handling.
 *
 * Key behaviors:
 * - No env var: Returns default `ws://localhost:6252/bus` with explicit port 6252
 * - Env var with explicit port: Uses that port
 * - Env var without port (e.g., `wss://bus.example.com/bus`): Preserves URL as-is,
 * returns `port: undefined` so protocol defaults (443 for wss://) are respected
 * @param envValue - The value of MAKAIO_BUS_URL environment variable (or undefined)
 * @returns Parsed configuration with href, port, and isDefault flag
 * @example
 * ```typescript
 * // No env var - local development
 * const config = parseBusUrl(undefined);
 * // { href: 'ws://localhost:6252/bus', port: 6252, isDefault: true }
 *
 * // Production with explicit port
 * const config = parseBusUrl('wss://bus.example.com:9000/bus');
 * // { href: 'wss://bus.example.com:9000/bus', port: 9000, isDefault: false }
 *
 * // Production with protocol default port
 * const config = parseBusUrl('wss://bus.example.com/bus');
 * // { href: 'wss://bus.example.com/bus', port: undefined, isDefault: false }
 * ```
 */
export function parseBusUrl(envValue: string | undefined): BusUrlConfig {
  const isDefault = !envValue;
  const url = new URL(envValue ?? DEFAULT_BUS_URL);

  if (isDefault) {
    const defaultPort = parseInt(url.port, 10);
    // Default localhost: ensure explicit port for clarity
    return {
      href: `${url.protocol}//${url.hostname}:${defaultPort}${url.pathname}`,
      port: defaultPort,
      isDefault: true,
    };
  }

  // User-provided URL: respect their configuration
  // If they specified a port, use it; if not, let protocol defaults apply
  const port = url.port ? parseInt(url.port, 10) : undefined;

  return {
    href: url.href,
    port,
    isDefault: false,
  };
}
