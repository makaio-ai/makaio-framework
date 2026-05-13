/**
 * Binary-resolution logic for managed and global client binaries.
 *
 * {@link ClientBinaryResolver} handles the `client.resolveBinary` responsibility:
 * resolving the execution context for an active binary via the managed path or
 * the global PATH fallback, without touching `pendingClients`, the job runner,
 * or the feed cache.
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import type { ClientDefinition, ClientExecutionContext } from '@makaio/contracts/client';
import { ClientBinaryStorageSubjects } from './storage/client-binary-storage-namespace.js';
import { BinaryNotFoundError } from './client-binary-errors.js';
import { isPathWithinBase } from './client-binary-manager-types.js';
import type { ClientDefinitionLookup } from './client-binary-manager-types.js';
import type { StrategyDependencies } from './binary-strategies/index.js';
import { assertSupportedBinaryVersion } from './client-binary-version-support.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Result of config isolation resolution for a managed binary. */
interface IsolatedConfigResult {
  /** Absolute path to the isolated config directory, or null when isolation is not configured. */
  configDir: string | null;
  /** Environment overrides to apply when spawning the binary. */
  env: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Construction options
// ---------------------------------------------------------------------------

/**
 * Dependencies required by {@link ClientBinaryResolver}.
 */
export interface ClientBinaryResolverDeps {
  /** Bus instance for storage requests and PATH-scan emissions. */
  bus: IMakaioBus;
  /** Already-validated absolute base path for managed binary installs. */
  resolvedBasePath: string;
  /** Already-validated absolute base path for per-client config isolation directories. */
  resolvedConfigBasePath: string;
  /** Client definition lookup for retrieving registered definitions. */
  definitionLookup: ClientDefinitionLookup;
  /** Strategy exec dependency, forwarded for future resolution-time verification. */
  exec: StrategyDependencies['exec'];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Resolves the execution context for a managed or globally-installed client binary.
 *
 * **Responsibilities:**
 * - Look up the active managed version from storage and build a fully-populated
 *   {@link ClientExecutionContext} with the versioned binary path and optional
 *   isolated config dir.
 * - Fall back to a global PATH scan when no managed version is active.
 * - Validate stored install paths against the expected managed-binary directory.
 *
 * This class has no dependency on `pendingClients`, the job runner, or the
 * feed cache — it is a pure resolution concern and is an internal implementation
 * detail of the binary manager.
 */
export class ClientBinaryResolver {
  private readonly bus: IMakaioBus;
  private readonly resolvedBasePath: string;
  private readonly resolvedConfigBasePath: string;
  private readonly definitionLookup: ClientDefinitionLookup;
  // Reserved for future resolution-time verification (e.g. binary liveness checks).

  private readonly exec: StrategyDependencies['exec'];

  /**
   * @param deps - Resolution dependencies
   */
  public constructor(deps: ClientBinaryResolverDeps) {
    this.bus = deps.bus;
    this.resolvedBasePath = deps.resolvedBasePath;
    this.resolvedConfigBasePath = deps.resolvedConfigBasePath;
    this.definitionLookup = deps.definitionLookup;
    this.exec = deps.exec;
  }

  // -------------------------------------------------------------------------
  // Public entry point
  // -------------------------------------------------------------------------

  /**
   * Resolve the execution context for a given client binary.
   *
   * Resolution follows a two-step priority chain:
   * 1. **Managed:** If the client has an active managed version, return the
   *    versioned binary path, an isolated config dir (when `configIsolation` is
   *    declared), and the corresponding env override.
   * 2. **Global fallback:** If no managed version is active, request
   *    `client.scan` to detect the binary on PATH. Returns `binaryPath: null`
   *    (caller uses PATH) and the `defaultPath` from `configIsolation` (tilde
   *    expanded), or its parent directory for file-level overrides, as the
   *    config dir.
   *
   * Throws when:
   * - No definition is registered for `clientId`.
   * - The global scan finds no binary (either the scan returns `found: false`
   *   or returns no result entry for the client).
   * @param clientId - Stable client identifier to resolve
   * @returns Fully populated {@link ClientExecutionContext}
   */
  public async resolve(clientId: string): Promise<ClientExecutionContext> {
    const definition = this.definitionLookup.getDefinition(clientId);
    if (definition === undefined) {
      throw new Error(`client.resolveBinary: no definition registered for client '${clientId}'`);
    }

    // Read the active pointer and installed-version rows from one storage
    // snapshot so a version change cannot pair an activeVersion from one
    // commit with version rows from another.
    const { state, versions } = await this.bus.request(ClientBinaryStorageSubjects.getSnapshot, { clientId });
    const activeVersion = state?.activeVersion ?? null;

    if (activeVersion !== null) {
      return this.buildManagedContext(clientId, activeVersion, definition, versions);
    }

    // No active managed version — fall back to global PATH detection.
    return this.buildGlobalContext(clientId, definition);
  }

  // -------------------------------------------------------------------------
  // Install path validation (used by manager for setActive and uninstall too)
  // -------------------------------------------------------------------------

  /**
   * Return `true` when `installPath` resolves within `config.basePath`.
   *
   * Used to guard against tampered or corrupted storage rows that could reference
   * paths outside the managed binary root.
   * @param installPath - Stored install path from a version record
   * @returns `true` when the path is safely within the base directory
   */
  public isInstallPathWithinBase(installPath: string): boolean {
    return isPathWithinBase(this.resolvedBasePath, installPath);
  }

  /**
   * Return `true` when a stored install path canonicalizes to the expected
   * directory, or a descendant of it, for a client/version pair.
   *
   * The base-path check alone is not enough: corrupted storage for one client
   * could otherwise point at another client's managed directory under the same
   * root. The realpath checks close the symlink gap: a lexical child such as
   * `{basePath}/{clientId}/{version}/link` is rejected when it points outside
   * the canonical expected root. Activation and uninstall may operate on a
   * nested binary directory because strategy artifacts describe the installed
   * binary directory, while the storage row must still stay within
   * `{basePath}/{clientId}/{version}`.
   *
   * Used by write operations (setActive, uninstall) and the managed binary
   * resolution read path.
   * @param installPath - Stored install path from a version record
   * @param clientId - Stable client identifier from the request
   * @param version - Version string from the request
   * @returns `true` when the canonical path is inside the expected install directory
   */
  public async isExpectedInstallPath(installPath: string, clientId: string, version: string): Promise<boolean> {
    if (!path.isAbsolute(installPath) || !this.isInstallPathWithinBase(installPath)) {
      return false;
    }
    const expectedRoot = path.resolve(this.resolvedBasePath, clientId, version);
    if (!this.isInstallPathWithinBase(expectedRoot)) {
      return false;
    }
    try {
      const [realBasePath, realExpectedRoot, realInstallPath] = await Promise.all([
        fs.realpath(this.resolvedBasePath),
        fs.realpath(expectedRoot),
        fs.realpath(installPath),
      ]);
      if (!isPathWithinBase(realBasePath, realExpectedRoot)) {
        return false;
      }
      return realInstallPath === realExpectedRoot || isPathWithinBase(realExpectedRoot, realInstallPath);
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Private resolution helpers
  // -------------------------------------------------------------------------

  /**
   * Build a managed {@link ClientExecutionContext} for an active installed version.
   * @param clientId - Stable client identifier
   * @param version - Active managed version string
   * @param definition - Client definition
   * @param versions - Pre-fetched installed-version records for this client
   * @returns Managed execution context
   */
  private async buildManagedContext(
    clientId: string,
    version: string,
    definition: ClientDefinition,
    versions: readonly { version: string; installPath: string }[],
  ): Promise<ClientExecutionContext> {
    const versionRecord = versions.find((entry) => entry.version === version);
    if (versionRecord === undefined) {
      throw new Error(`client.resolveBinary: active version '${version}' is not installed for client '${clientId}'`);
    }

    if (!(await this.isExpectedInstallPath(versionRecord.installPath, clientId, version))) {
      throw new Error(
        `client.resolveBinary: stored installPath "${versionRecord.installPath}" does not match the expected install directory for ${clientId}@${version}`,
      );
    }

    if (definition.binary !== undefined) {
      assertSupportedBinaryVersion(
        'client.resolveBinary',
        clientId,
        version,
        definition.binary.supportedVersions,
        'managed binary version',
      );
    }

    const binaryRelPath = toVersionCommandTuple(definition.versionCommand)?.[0];
    if (binaryRelPath === undefined) {
      throw new Error(
        `client.resolveBinary: definition for '${clientId}' has no versionCommand — cannot derive binary path`,
      );
    }
    const binaryPath = path.resolve(versionRecord.installPath, binaryRelPath);
    const normalizedInstall = path.resolve(versionRecord.installPath);
    if (!binaryPath.startsWith(normalizedInstall + path.sep) && binaryPath !== normalizedInstall) {
      throw new Error(`client.resolveBinary: versionCommand for '${clientId}' resolves outside the install directory`);
    }

    const { configDir, env } = this.resolveIsolatedConfig(clientId, definition);

    return { binaryPath, env, configDir, source: 'managed', version };
  }

  /**
   * Build a global-fallback {@link ClientExecutionContext} by scanning PATH.
   *
   * Sends a `client.scan` request for the client's declared binary name.
   * Throws when the scan reports `found: false` or returns no entry.
   * @param clientId - Stable client identifier
   * @param definition - Client definition
   * @returns Global execution context with null binaryPath
   */
  private async buildGlobalContext(clientId: string, definition: ClientDefinition): Promise<ClientExecutionContext> {
    if (!definition.binary?.name) {
      throw new Error(`client.resolveBinary: definition for '${clientId}' has no binary.name — cannot scan PATH`);
    }

    const scanTarget = {
      clientId,
      binaryName: definition.binary.name,
      supportedVersions: definition.binary.supportedVersions,
    };
    const { results } = await this.bus.request(ClientSubjects.scan, { targets: [scanTarget] });

    const scanResult = results.find((r) => r.clientId === clientId);
    if (scanResult === undefined || !scanResult.found) {
      throw new BinaryNotFoundError(clientId);
    }

    const version = scanResult.version ?? null;
    assertSupportedBinaryVersion(
      'client.resolveBinary',
      clientId,
      version,
      definition.binary.supportedVersions,
      'detected global binary version',
    );
    const configDir = this.resolveGlobalConfigDir(definition);

    return { binaryPath: null, env: {}, configDir, source: 'global', version };
  }

  /**
   * Derive the isolated config dir and env override for a managed binary.
   *
   * When the definition does not declare `configIsolation`, returns empty env
   * and null configDir. Otherwise constructs the isolated config directory from
   * `resolvedConfigBasePath` and maps the env var to either that directory or a
   * file inside it, depending on the client's `pathKind`.
   * @param clientId - Stable client identifier
   * @param definition - Client definition
   * @returns Resolved configDir and env record
   */
  private resolveIsolatedConfig(clientId: string, definition: ClientDefinition): IsolatedConfigResult {
    const { configIsolation } = definition;
    if (configIsolation === undefined) {
      return { configDir: null, env: {} };
    }
    const configDir = path.join(this.resolvedConfigBasePath, clientId, 'config');
    const envValue =
      configIsolation.pathKind === 'file'
        ? path.join(configDir, path.basename(configIsolation.defaultPath))
        : configDir;
    return { configDir, env: { [configIsolation.envVar]: envValue } };
  }

  /**
   * Resolve the global config directory for a client by expanding the tilde in
   * `configIsolation.defaultPath`.
   *
   * File-level overrides return the containing directory, because
   * {@link ClientExecutionContext.configDir} remains a directory even when the
   * env var points at a file. Returns `null` when the definition does not
   * declare `configIsolation`.
   *
   * The guard below catches definition-time mistakes (e.g. a relative path
   * written in the client package). The schema intentionally accepts the
   * human-readable tilde form (`~/...`) rather than a pre-expanded absolute
   * path, so the path-absoluteness invariant is enforced here after expansion
   * rather than at parse time.
   * @param definition - Client definition
   * @returns Expanded config directory path, or null
   */
  private resolveGlobalConfigDir(definition: ClientDefinition): string | null {
    const { configIsolation } = definition;
    if (configIsolation === undefined) {
      return null;
    }
    // Expand leading `~` to the OS home directory. Only the exact `~/` prefix
    // or standalone `~` is expanded — no other tilde forms are supported.
    const defaultPath = configIsolation.defaultPath;
    const expandedPath =
      defaultPath === '~'
        ? os.homedir()
        : defaultPath.startsWith('~/')
          ? path.join(os.homedir(), defaultPath.slice(2))
          : defaultPath;

    const resolvedDir = configIsolation.pathKind === 'file' ? path.dirname(expandedPath) : expandedPath;

    if (!path.isAbsolute(resolvedDir)) {
      throw new Error(
        `ConfigIsolation defaultPath for '${definition.id}' resolved to non-absolute path '${expandedPath}'; use an absolute or tilde-expanded path (e.g. '~/.myapp')`,
      );
    }

    return resolvedDir;
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Narrow a raw `versionCommand` array to the `[string, ...string[]]` tuple
 * type required for binary-path derivation.
 *
 * Returns `undefined` when `versionCommand` is absent or empty so callers
 * can use a simple `!= undefined` guard to decide whether to proceed.
 * @param versionCommand - Raw array from the client definition, or `undefined`
 * @returns Typed non-empty tuple, or `undefined`
 */
export function toVersionCommandTuple(
  versionCommand: readonly string[] | undefined,
): readonly [string, ...string[]] | undefined {
  if (versionCommand === undefined || versionCommand.length === 0) {
    return undefined;
  }
  return versionCommand as readonly [string, ...string[]];
}
