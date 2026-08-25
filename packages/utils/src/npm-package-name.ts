/**
 * Maximum character length of an npm package name.
 *
 * npm limits package names to 214 ASCII characters. This utility deliberately
 * accepts the portable registry-name subset used where a package name becomes
 * part of a filesystem path; it does not parse npm's broader specifier syntax.
 */
export const NPM_PACKAGE_NAME_MAX_LENGTH = 214;

/** Matches an ordinary registry package name, with or without a scope. */
const NPM_PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

/**
 * Windows device names, reserved with or without a suffix (for example,
 * `CON.js`).
 *
 * An npm package name becomes a directory name below `node_modules`, so the
 * portable subset this utility accepts cannot include a final segment Windows
 * resolves as a device. The scope segment starts with `@` and is therefore not
 * a device name; only the package-name segment is checked.
 */
const WINDOWS_DEVICE_PACKAGE_SEGMENT = /^(?:con|prn|aux|nul|(?:com|lpt)[0-9])(?:\.|$)/u;

/**
 * Determine whether a value has the ordinary npm package-name spelling.
 *
 * Local paths, git URLs, tags, versions, and subpaths are npm specifiers, not
 * package names, and are intentionally rejected here.
 * @param value - Candidate package name.
 * Length is deliberately separate: callers can retain their own error message
 * for a syntactically valid name that exceeds {@link NPM_PACKAGE_NAME_MAX_LENGTH}.
 * @returns Whether the value has npm's ordinary package-name syntax.
 */
export function isNpmPackageName(value: string): boolean {
  if (!NPM_PACKAGE_NAME_PATTERN.test(value)) return false;

  const packageSegment = value.slice(value.lastIndexOf('/') + 1);
  return !packageSegment.endsWith('.') && !WINDOWS_DEVICE_PACKAGE_SEGMENT.test(packageSegment);
}
