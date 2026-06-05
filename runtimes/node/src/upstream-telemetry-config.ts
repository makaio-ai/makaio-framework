import type { BusTransport } from '@makaio/bus-core';
import { HmacAuth, WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import type { UpstreamTelemetryBootOptions } from './boot-types.js';

/**
 * Environment surface used by {@link resolveUpstreamTelemetryBootOptionsFromEnv}.
 */
export interface UpstreamTelemetryEnv {
  /** WebSocket URL for the upstream collector bus. */
  readonly MAKAIO_UPSTREAM_URL?: string;
  /** Optional HMAC secret for the upstream collector bus. */
  readonly MAKAIO_UPSTREAM_SECRET?: string;
}

/**
 * Transport factory input resolved from upstream telemetry environment.
 */
export interface UpstreamTelemetryTransportConfig {
  /** WebSocket URL for the upstream collector bus. */
  readonly url: string;
  /** Optional HMAC secret for upstream bus authentication. */
  readonly secret?: string;
}

/**
 * Options for resolving push embedded upstream telemetry boot configuration.
 */
export interface ResolveUpstreamTelemetryBootOptionsFromEnvOptions {
  /** Environment variables to read. Defaults to `process.env`. */
  readonly env?: UpstreamTelemetryEnv;
  /** Transport factory override for tests and alternate host transports. */
  readonly createTransport?: (config: UpstreamTelemetryTransportConfig) => BusTransport;
}

/** Environment variable that enables push embedded upstream telemetry. */
export const MAKAIO_UPSTREAM_URL_ENV = 'MAKAIO_UPSTREAM_URL';

/** Environment variable carrying the optional HMAC secret for upstream telemetry. */
export const MAKAIO_UPSTREAM_SECRET_ENV = 'MAKAIO_UPSTREAM_SECRET';

const UPSTREAM_TELEMETRY_TRANSPORT_NAME = 'upstream-telemetry-ws';

/**
 * Create the default upstream telemetry WebSocket transport.
 * @param config - Resolved upstream telemetry transport configuration.
 * @returns WebSocket client transport configured for upstream telemetry.
 */
export function createUpstreamTelemetryTransport(config: UpstreamTelemetryTransportConfig): BusTransport {
  return new WebSocketClientTransport({
    url: config.url,
    name: UPSTREAM_TELEMETRY_TRANSPORT_NAME,
    auth: config.secret === undefined ? undefined : new HmacAuth({ secret: config.secret }),
  });
}

/**
 * Resolve push embedded upstream telemetry boot options from environment.
 *
 * `MAKAIO_UPSTREAM_URL` is the activation switch. When it is absent or blank,
 * no upstream telemetry transport is created. `MAKAIO_UPSTREAM_SECRET` is
 * optional, but when set it must be non-empty and requires a URL.
 * @param options - Environment and transport factory overrides.
 * @returns Boot options for projected upstream telemetry, or `undefined` when disabled.
 */
export function resolveUpstreamTelemetryBootOptionsFromEnv(
  options: ResolveUpstreamTelemetryBootOptionsFromEnvOptions = {},
): UpstreamTelemetryBootOptions | undefined {
  const env = options.env ?? process.env;
  const secret = normalizeUpstreamSecret(env[MAKAIO_UPSTREAM_SECRET_ENV]);
  const url = normalizeOptionalUrl(env[MAKAIO_UPSTREAM_URL_ENV]);

  if (url === undefined) {
    if (secret !== undefined) {
      throw new Error(`${MAKAIO_UPSTREAM_SECRET_ENV} requires ${MAKAIO_UPSTREAM_URL_ENV}`);
    }
    return undefined;
  }

  const createTransport = options.createTransport ?? createUpstreamTelemetryTransport;
  return {
    transport: createTransport({ url, ...(secret !== undefined ? { secret } : {}) }),
  };
}

/**
 * Normalize an optional URL environment value.
 * @param raw - Raw environment value.
 * @returns Trimmed URL string, or `undefined` when unset/blank.
 */
function normalizeOptionalUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * Normalize the optional upstream HMAC secret.
 * @param raw - Raw environment value.
 * @returns Trimmed secret, or `undefined` when unset.
 * @throws When the variable is set but empty after trimming.
 */
function normalizeUpstreamSecret(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new Error(`${MAKAIO_UPSTREAM_SECRET_ENV} is set but empty after trimming; refusing to use an empty secret`);
  }

  return trimmed;
}
