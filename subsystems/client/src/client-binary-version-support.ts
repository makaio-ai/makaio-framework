import { isUniversalRange, versionSatisfies } from '@makaio/contracts';

// Duplicated in adapter-client-refs.ts — kept inline to avoid
// a cross-subsystem dependency for a single env-var read.
const SKIP_VERSION_CHECK = process.env.MAKAIO_SKIP_CLIENT_VERSION_CHECK === '1';

/**
 * Assert that a detected or resolved binary version satisfies the client
 * definition's supported version range.
 * @param subject - Bus subject used in the error prefix.
 * @param clientId - Stable client identifier.
 * @param version - Detected or resolved binary version, or null when unknown.
 * @param supportedVersions - SemVer range declared by the client definition.
 * @param versionLabel - Human-readable source of the version.
 */
export function assertSupportedBinaryVersion(
  subject: string,
  clientId: string,
  version: string | null,
  supportedVersions: string,
  versionLabel: string,
): void {
  if (version === null) {
    if (isUniversalRange(supportedVersions)) return;
    if (SKIP_VERSION_CHECK) {
      console.warn(
        `[SKIP_VERSION_CHECK] ${subject}: ${versionLabel} for client '${clientId}' did not report a version; requires ${supportedVersions}`,
      );
      return;
    }
    throw new Error(
      `${subject}: ${versionLabel} for client '${clientId}' did not report a version; requires ${supportedVersions}`,
    );
  }

  if (versionSatisfies(version, supportedVersions)) return;

  if (SKIP_VERSION_CHECK) {
    console.warn(
      `[SKIP_VERSION_CHECK] ${subject}: ${versionLabel} ${version} for client '${clientId}' does not satisfy ${supportedVersions} — check bypassed`,
    );
    return;
  }

  throw new Error(
    `${subject}: ${versionLabel} ${version} for client '${clientId}' does not satisfy ${supportedVersions}`,
  );
}
