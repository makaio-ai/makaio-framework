import type { MakaioBusLike } from '@makaio/core';
import type { CredentialRef } from '../config/credential-ref.js';
import type { ExtensionToken } from './extension-token.js';
import type { ExtensionIdentity } from './extension-lifecycle.js';

/**
 * Host-supplied capability for resolving credential references at extension init time.
 *
 * Provided by the Node runtime on {@link NodeExtensionContext.credentials}. Extensions
 * should call this instead of opening the credential channel directly so that the
 * framework can degrade gracefully in headless hosts where the product-side credential
 * service is not running.
 *
 * Resolution semantics by scheme:
 * - `env:<VAR>` — reads the named environment variable from the current process.
 * - `file:<path>` — reads the file at the given absolute path.
 * - `keychain:<service>:<account>` — reads macOS Keychain (other platforms return null).
 * - `stored:providerConfig:<configId>:<key>` — fetches through the host's credential
 *   service when one is registered; returns `null` with a warning when no handler is
 *   registered (bare headless hosts without the credential service).
 *
 * Extensions **must never log resolved values** — treat them as secrets at all times.
 */
export interface CredentialResolver {
  /**
   * Resolve a credential reference to its runtime value.
   *
   * Returns `null` when the referenced credential is unavailable (environment
   * variable unset, file missing, keychain entry absent, or `stored:` service
   * not registered).
   * @param ref - Branded credential reference string.
   * @returns Resolved plaintext value, or `null` when unavailable.
   */
  resolve(ref: CredentialRef): Promise<string | null>;
}

/**
 * Generic context provided by a host runtime when creating an extension's service.
 *
 * Contains host-agnostic runtime seams: the bus instance, extension identity,
 * extension-local data directory, machine identity, config, service lookup, and
 * lifecycle controls. Host-specific environment details belong on explicit
 * context extensions such as {@link NodeExtensionContext}.
 */
export interface ExtensionContext<TBus extends MakaioBusLike = MakaioBusLike> {
  /** Bus instance for registering handlers and emitting events. */
  readonly bus: TBus;
  /** Coordinator-minted identity for the extension being created. */
  readonly identity: ExtensionIdentity;
  /**
   * Per-extension writable data directory resolved by the host runtime.
   *
   * Use this for extension-local persistence (caches, state files, etc.).
   */
  readonly dataDir: string;
  /**
   * Stable machine identifier used for machine-scoped persistence and
   * encryption key derivation.
   *
   * Resolved by the composition root (e.g., `node-machine-id`) before
   * extensions are started.
   */
  readonly machineId: string;
  /**
   * Resolved configuration for this extension, merged from stored values and
   * descriptor defaults. Present only when the extension declared a
   * `configSchema` on its {@link MakaioExtension}.
   *
   * Extensions should parse this with their Zod schema to get typed config:
   * ```ts
   * const config = parseExtensionConfig(MyConfigSchema, ctx.config);
   * ```
   */
  readonly config?: unknown;
  /**
   * Retrieve a service exposed by another active extension.
   * @param token - Extension-owned token identifying the desired service.
   * @returns The active service instance, or `undefined` when unavailable.
   */
  getService<T>(token: ExtensionToken<T>): T | undefined;
  /**
   * Attempt a dynamic import, returning `null` when the package is not installed.
   *
   * Only swallows errors caused by the package itself being absent. Transitive
   * dependency failures and module evaluation errors are re-thrown.
   * @typeParam T - Expected module shape (caller-asserted, not runtime-verified).
   * @param specifier - Package specifier to import.
   * @returns The imported module cast to `T`, or `null` when the package is not installed.
   */
  readonly tryImport: <T>(specifier: string) => Promise<T | null>;
  /**
   * Abort signal triggered during graceful shutdown.
   *
   * Extensions can pass this to long-running operations (fetch, timers, streams)
   * so they cancel promptly when the runtime is stopping.
   */
  readonly signal: AbortSignal;
  /**
   * Check whether an extension with the given name is active.
   *
   * Returns `true` when the named extension has been loaded and reached
   * `active` state. Use this for optional integration checks without
   * requiring an ExtensionToken.
   * @param name - Extension name to check.
   * @returns `true` when the extension is active.
   */
  readonly hasExtension: (name: string) => boolean;
}

/**
 * Node.js host extension context.
 *
 * Adds the OS and filesystem fields supplied by Node-based composition roots.
 * Extensions that need these fields should opt into this context explicitly;
 * host-agnostic extensions can type themselves against {@link ExtensionContext}.
 */
export interface NodeExtensionContext<TBus extends MakaioBusLike = MakaioBusLike> extends ExtensionContext<TBus> {
  /** Working directory selected by the Node host for relative filesystem operations. */
  readonly cwd?: string;
  /** Current platform identifier (e.g., `'darwin'`, `'linux'`, `'win32'`). */
  readonly platform: NodeJS.Platform;
  /** User's home directory path. */
  readonly homedir: string;
  /** Resolved `.makaio` directory root (e.g., `~/.makaio`). */
  readonly makaioHome: string;
  /** Current OS username. */
  readonly username: string;
  /**
   * WebSocket URL for the host bus, when the runtime exposes one.
   *
   * Detached `bus-websocket` extensions use this to connect back to the host.
   * Hosts without a WebSocket bus omit it.
   */
  readonly busUrl?: string;
  /**
   * Host-supplied credential resolver for resolving `CredentialRef` values.
   *
   * Resolves `env:`, `file:`, and `keychain:` references locally; resolves
   * `stored:providerConfig:<configId>:<key>` through the host's credential
   * service when one is registered, returning `null` with a warning when none
   * is available (bare headless hosts).
   *
   * Absent when the host does not provide one (e.g., browser-only contexts).
   * Extensions **must never log resolved values**.
   */
  readonly credentials?: CredentialResolver;
}
