import { isIP } from 'node:net';

/** Resolved Bun HTTP server bind configuration. */
export interface BunServerEnvConfig {
  /** HTTP server port. */
  readonly port: number;
  /** Bind host. */
  readonly host: string;
}

/** Policy for invalid environment values. */
export type InvalidBunServerEnvPolicy = 'throw' | 'warn';

/** Options for reading Bun server bind configuration from an env object. */
export interface ReadBunServerEnvOptions {
  /** Application label used in warnings. */
  readonly appName: string;
  /** Environment object. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Default HTTP port. Defaults to 3000. */
  readonly defaultPort?: number;
  /** Default bind host. Defaults to `0.0.0.0`. */
  readonly defaultHost?: string;
  /** Invalid-value policy. Defaults to `throw`. */
  readonly invalid?: InvalidBunServerEnvPolicy;
}

const DEFAULT_PORT = 3000;
const MAX_PORT = 65535;
const DEFAULT_HOST = '0.0.0.0';
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

/**
 * Read and validate Bun server bind configuration from environment variables.
 * @param options - Env source, defaults, and invalid-value policy.
 * @returns Resolved Bun server bind configuration.
 */
export function readBunServerEnv(options: ReadBunServerEnvOptions): BunServerEnvConfig {
  const env = options.env ?? process.env;
  const defaultPort = options.defaultPort ?? DEFAULT_PORT;
  const defaultHost = options.defaultHost ?? DEFAULT_HOST;
  return {
    port: readPort(env['PORT'], defaultPort, options),
    host: readHost(env['HOST'], defaultHost, options),
  };
}

/**
 * Read and validate the HTTP listen port.
 * @param rawPort - Raw `PORT` environment value.
 * @param defaultPort - Fallback port.
 * @param options - Invalid-value handling options.
 * @returns Valid TCP port.
 */
function readPort(rawPort: string | undefined, defaultPort: number, options: ReadBunServerEnvOptions): number {
  const trimmed = rawPort?.trim();
  const port = trimmed && /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
  if (Number.isInteger(port) && port >= 1 && port <= MAX_PORT) {
    return port;
  }
  if (rawPort !== undefined) {
    return handleInvalidNumber(`Invalid PORT: ${rawPort}`, defaultPort, options);
  }
  return defaultPort;
}

/**
 * Read and validate the HTTP bind host.
 * @param rawHost - Raw `HOST` environment value.
 * @param defaultHost - Fallback host.
 * @param options - Invalid-value handling options.
 * @returns Hostname or IP address.
 */
function readHost(rawHost: string | undefined, defaultHost: string, options: ReadBunServerEnvOptions): string {
  const host = rawHost?.trim();
  if (host && isValidBindHost(host)) {
    return host;
  }
  if (rawHost !== undefined) {
    return handleInvalidString(`Invalid HOST: ${rawHost}`, defaultHost, options);
  }
  return defaultHost;
}

/**
 * Validate a Bun listen hostname.
 * @param host - Trimmed hostname candidate.
 * @returns Whether the host is an IP address, localhost, or DNS hostname.
 */
function isValidBindHost(host: string): boolean {
  return isIP(host) !== 0 || host === 'localhost' || HOSTNAME_PATTERN.test(host);
}

/**
 * Handle an invalid numeric env value.
 * @param message - Error or warning message.
 * @param fallback - Fallback value returned when warnings are enabled.
 * @param options - Invalid-value handling options.
 * @returns Fallback value when warnings are enabled.
 */
function handleInvalidNumber(message: string, fallback: number, options: ReadBunServerEnvOptions): number {
  handleInvalid(message, String(fallback), options);
  return fallback;
}

/**
 * Handle an invalid string env value.
 * @param message - Error or warning message.
 * @param fallback - Fallback value returned when warnings are enabled.
 * @param options - Invalid-value handling options.
 * @returns Fallback value when warnings are enabled.
 */
function handleInvalidString(message: string, fallback: string, options: ReadBunServerEnvOptions): string {
  handleInvalid(message, fallback, options);
  return fallback;
}

/**
 * Apply the configured invalid-value policy.
 * @param message - Error or warning message.
 * @param fallback - Fallback value included in warnings.
 * @param options - Invalid-value handling options.
 */
function handleInvalid(message: string, fallback: string, options: ReadBunServerEnvOptions): void {
  if ((options.invalid ?? 'throw') === 'throw') {
    throw new Error(message);
  }
  console.warn(`[${options.appName}] ${message}, falling back to ${fallback}`);
}
