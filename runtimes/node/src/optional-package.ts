type OptionalRuntimePackagePath = {
  rootPackageName: string;
  subpath: string | undefined;
};

/**
 * Detect the intentional absence of an optional runtime package.
 *
 * Only errors proving the named package itself is missing are swallowed.
 * Transitive dependency failures or module evaluation errors must surface so
 * callers do not treat a broken package the same as an absent one.
 * @param error - Dynamic import error.
 * @param packageName - Exact package name the host attempted to import.
 * @returns `true` when the named package is not installed.
 */
export function isMissingOptionalRuntimePackage(error: unknown, packageName: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const { rootPackageName, subpath } = splitPackageSubpath(packageName);
  const candidatePackageNames = subpath === undefined ? [packageName] : [packageName, rootPackageName];
  const missingPackageMessages = candidatePackageNames.flatMap((name) => [
    `Cannot find package '${name}'`,
    `Cannot find module '${name}'`,
    `Cannot find package "${name}"`,
    `Cannot find module "${name}"`,
  ]);
  const errnoError = error as NodeJS.ErrnoException;
  if (
    (errnoError.code === 'ERR_MODULE_NOT_FOUND' || errnoError.code === 'MODULE_NOT_FOUND') &&
    missingPackageMessages.some((message) => error.message.includes(message))
  ) {
    return true;
  }

  if (
    errnoError.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' &&
    subpath !== undefined &&
    error.message.includes(`Package subpath '${subpath}' is not defined by "exports"`) &&
    mentionsPackageJsonFor(error.message, rootPackageName)
  ) {
    return true;
  }

  // Some runtimes omit `code` on import failures; fall back to the canonical
  // missing-package message patterns rather than treating the package as present.
  return missingPackageMessages.some((message) => error.message.includes(message));
}

/**
 * Attempt a dynamic import, returning `null` when the package is not installed.
 *
 * Only swallows errors caused by the package itself being absent. Transitive
 * dependency failures and module evaluation errors are re-thrown so callers
 * do not silently ignore broken packages.
 * @typeParam T - Expected module shape (caller-asserted, not runtime-verified).
 * @param specifier - Package specifier to import (e.g. `'@makaio/foo'` or `'@makaio/foo/runtime'`).
 * @returns The imported module cast to `T`, or `null` when the package is not installed.
 */
export async function tryImport<T>(specifier: string): Promise<T | null> {
  try {
    return (await import(/* @vite-ignore */ specifier)) as T;
  } catch (error) {
    if (isMissingOptionalRuntimePackage(error, specifier)) {
      return null;
    }
    throw error;
  }
}

/**
 * Split a package specifier into the exported package root and optional subpath.
 * @param packageName - Exact package specifier being imported
 * @returns Parsed root package name plus optional `./subpath`
 */
function splitPackageSubpath(packageName: string): OptionalRuntimePackagePath {
  const parts = packageName.split('/');
  if (packageName.startsWith('@')) {
    const rootPackageName = parts.slice(0, 2).join('/');
    const subpath = parts.length > 2 ? `./${parts.slice(2).join('/')}` : undefined;
    return { rootPackageName, subpath };
  }

  return {
    rootPackageName: parts[0] ?? packageName,
    subpath: parts.length > 1 ? `./${parts.slice(1).join('/')}` : undefined,
  };
}

/**
 * Check whether an export error clearly points at the requested package root.
 * @param message - Runtime import error message
 * @param packageName - Root package that was requested
 * @returns `true` when the message references that package's `package.json`
 */
function mentionsPackageJsonFor(message: string, packageName: string): boolean {
  const unixPackagePath = packageName;
  const windowsPackagePath = packageName.replaceAll('/', '\\');
  return (
    message.includes(`/${unixPackagePath}/package.json`) || message.includes(`\\${windowsPackagePath}\\package.json`)
  );
}
