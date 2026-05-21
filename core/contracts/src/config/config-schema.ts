import { z } from 'zod';

/**
 * Bootstrap config schema for Makaio runtime configuration.
 *
 * This is the minimal config needed to bootstrap the system - stored in
 * `~/.makaio/config.json`. It controls:
 * - Runtime mode (local/remote/hybrid)
 * - Bus connectivity for remote/hybrid modes
 * - Relay connection settings
 * @example
 * ```json
 * {
 *   "$schema": "makaio/config/v1",
 *   "mode": "local"
 * }
 * ```
 */
export const ConfigSchema = z.object({
  /**
   * Schema version identifier for forward compatibility.
   */
  $schema: z.literal('makaio/config/v1').default('makaio/config/v1'),

  /**
   * Runtime mode determining bus configuration.
   * - `local`: All communication stays on this machine
   * - `remote`: Connect to a remote bus server
   * - `hybrid`: Local bus with remote fallback
   */
  mode: z.enum(['local', 'remote', 'hybrid']).default('local'),

  /**
   * Machine role for relay routing. Automated triggers prefer 'server'.
   * - `main-dev-machine`: Primary developer workstation
   * - `server`: Headless server — preferred target for automated/cron triggers
   */
  role: z.enum(['main-dev-machine', 'server']).default('main-dev-machine'),

  /**
   * Bus configuration for remote/hybrid modes.
   */
  bus: z
    .object({
      /**
       * Remote bus configuration for connecting to a central makaio server.
       */
      remote: z
        .object({
          /**
           * URL of the remote bus endpoint.
           */
          url: z.string().url().optional(),

          /**
           * Shared secret for bus authentication.
           */
          secret: z.string().optional(),
        })
        .optional(),
    })
    .optional(),

  /**
   * Relay connection configuration for remote coordination.
   * If not provided or if url is not set, relay connection is disabled.
   */
  relay: z
    .object({
      /**
       * Relay server WebSocket URL.
       * If not provided, relay connection is disabled.
       * @example 'wss://relay.makaio.ai'
       */
      url: z.string().url().optional(),

      /**
       * Authentication token for relay HTTP endpoints.
       * Used as Bearer token for webhook activity and other HTTP APIs.
       */
      token: z.string().optional(),

      /**
       * Enable automatic reconnection on disconnect.
       * When enabled, the client will attempt to reconnect using exponential backoff.
       * @defaultValue true
       */
      autoReconnect: z.boolean().optional().default(true),

      /**
       * Maximum number of reconnection attempts before giving up.
       * Set to 0 for infinite reconnection attempts.
       * @defaultValue 5
       */
      maxReconnectAttempts: z.number().int().min(0).optional().default(5),

      /**
       * Heartbeat interval in milliseconds.
       * How often to send ping messages to keep the connection alive.
       * @defaultValue 30000 (30 seconds)
       */
      heartbeatInterval: z.number().int().positive().optional().default(30000),
    })
    .optional(),

  /**
   * Optional feature flags for gating services with prerequisites.
   */
  features: z
    .object({
      /**
       * Enable the AdapterVoiceBridge service.
       * Requires speech-capable adapters with valid credentials.
       * @defaultValue false
       */
      voiceBridge: z.boolean().default(false),
    })
    .optional(),

  /**
   * File watcher configuration.
   */
  fileWatcher: z
    .object({
      /**
       * Backend to use for file watching.
       * - `'auto'` — auto-detect best available (Watchman → \@parcel/watcher → Chokidar)
       * - `'watchman'` — use Watchman daemon
       * - `'parcel'` — use \@parcel/watcher native module
       * - `'chokidar'` — use Chokidar (universal JS fallback)
       * @defaultValue 'auto'
       */
      backend: z.enum(['auto', 'watchman', 'parcel', 'chokidar']).default('auto'),
    })
    .optional(),
});

/**
 * Inferred type for the bootstrap config.
 */
export type Config = z.infer<typeof ConfigSchema>;

/**
 * Relay connection configuration type, derived from the bootstrap config schema.
 */
export type RelayConfig = NonNullable<Config['relay']>;
