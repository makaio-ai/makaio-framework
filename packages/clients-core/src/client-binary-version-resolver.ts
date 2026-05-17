/**
 * Version resolution logic for managed client binaries.
 *
 * The {@link ClientBinaryVersionResolver} is a pure, synchronous, stateless
 * utility with no bus coupling of its own. It enforces the pin-only install
 * contract: every managed install must use the exact version declared in the
 * descriptor.
 *
 * It is consumed by the `ClientBinaryManager` which owns bus registration and
 * persistence.
 * @packageDocumentation
 */

import type { ManagedInstallDescriptor } from '@makaio/contracts/client';

// ---------------------------------------------------------------------------
// Public contracts
// ---------------------------------------------------------------------------

/**
 * Resolution result returned by {@link ClientBinaryVersionResolver.resolveInstallVersion}.
 */
export interface ResolvedInstallVersion {
  /**
   * Concrete version string to install.
   *
   * Always equals the pinned version from the descriptor. When an explicit
   * version was supplied by the caller it has been validated to match the pin.
   */
  readonly version: string;
  /**
   * `true` when the version was supplied explicitly by the caller and matches
   * the descriptor pin; `false` when the pin was used directly.
   */
  readonly explicit: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Synchronous, stateless version resolver for managed client binaries.
 *
 * The resolver enforces the pin-only install contract:
 * - When no explicit version is supplied, it returns the descriptor pin.
 * - When an explicit version is supplied, it is accepted only when it equals
 *   the descriptor pin; any mismatch throws immediately so the caller can
 *   reject the request with a clear message.
 *
 * No network calls, no cache, no async I/O. The concrete version is always
 * known at construction time from the descriptor.
 */
export class ClientBinaryVersionResolver {
  /**
   * Resolve the version to install for a `client.install` request.
   *
   * When `explicitVersion` is `undefined`, the descriptor pin is returned
   * directly. When `explicitVersion` is provided, it must exactly match the
   * pin or an error is thrown. Whitespace-only explicit versions are also
   * rejected.
   * @param clientId - Stable client identifier (e.g. `'claude-code'`)
   * @param descriptor - Managed install descriptor carrying the pinned version
   * @param explicitVersion - Version string supplied by the caller, or
   *   `undefined` to use the descriptor pin
   * @returns Resolved version and whether it was explicitly requested
   * @throws When `explicitVersion` is an empty/whitespace-only string
   * @throws When `explicitVersion` does not match the descriptor pin
   */
  public resolveInstallVersion(
    clientId: string,
    descriptor: ManagedInstallDescriptor,
    explicitVersion?: string,
  ): ResolvedInstallVersion {
    const pinnedVersion = descriptor.version;
    if (explicitVersion === undefined) {
      return { version: pinnedVersion, explicit: false };
    }
    const requested = explicitVersion.trim();
    if (requested.length === 0) {
      throw new Error('Explicit version returned an empty version string');
    }
    if (requested !== pinnedVersion) {
      throw new Error(
        `client.install: requested version ${requested} for client '${clientId}' does not match pinned version ${pinnedVersion}`,
      );
    }
    return { version: requested, explicit: true };
  }
}
