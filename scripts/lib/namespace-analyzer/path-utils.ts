import { posix as pathPosix, relative } from 'node:path';

/**
 * Normalizes analyzer inventory paths to POSIX separators for stable JSON and
 * Markdown output across operating systems.
 * @param filePath - The path emitted by the analyzer.
 * @returns The path with backslashes replaced by forward slashes.
 */
export function normalizeInventoryPath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

/**
 * Computes a stable analyzer path relative to an analysis root.
 * @param root - Absolute analysis root path.
 * @param filePath - Absolute source file path.
 * @returns A POSIX path relative to the analysis root.
 */
export function relativeInventoryPath(root: string, filePath: string): string {
  return normalizeInventoryPath(relative(root, filePath));
}

/**
 * Checks whether an analysis root is the standalone framework distribution root.
 * @param root - Absolute analysis root path.
 * @returns `true` when the root directory is named `framework`.
 */
export function isFrameworkDistributionRoot(root: string): boolean {
  return normalizeInventoryPath(root).replace(/\/+$/, '').split('/').at(-1) === 'framework';
}

/**
 * Checks whether a source file should be excluded from an analyzer pass.
 * @param root - Absolute analysis root path.
 * @param filePath - Absolute source file path.
 * @param prefixes - POSIX path prefixes relative to the analysis root.
 * @returns `true` when the file is under one of the excluded prefixes.
 */
export function matchesInventoryPathPrefix(root: string, filePath: string, prefixes: readonly string[] = []): boolean {
  const relativePath = relativeInventoryPath(root, filePath);

  return prefixes.some((prefix) => {
    const normalizedPrefix = normalizeInventoryPath(prefix).replace(/^\/+/, '').replace(/\/+$/, '');
    return (
      normalizedPrefix.length > 0 &&
      (relativePath === normalizedPrefix || relativePath.startsWith(`${normalizedPrefix}/`))
    );
  });
}

/**
 * Computes a Markdown link from a generated doc file to a source file.
 * @param docFilePath - Generated doc path relative to the output directory, without `.md`.
 * @param sourceFile - Source file path relative to `sourceRoot`.
 * @param docsRoot - Output directory path relative to the analysis root.
 * @param sourceRoot - Source root path relative to the analysis root.
 * @returns A POSIX relative link from the doc file directory to the source file.
 */
export function relativeSourcePath(
  docFilePath: string,
  sourceFile: string,
  docsRoot: string,
  sourceRoot: string,
): string {
  const normalizedDocsRoot = normalizeInventoryPath(docsRoot).replace(/\/+$/, '');
  const normalizedDocFilePath = normalizeInventoryPath(docFilePath);
  const docDir = normalizedDocFilePath.includes('/')
    ? `${normalizedDocsRoot}/${normalizedDocFilePath.slice(0, normalizedDocFilePath.lastIndexOf('/'))}`
    : normalizedDocsRoot;
  const normalizedSourceRoot = normalizeInventoryPath(sourceRoot).replace(/\/+$/, '');
  const normalizedSourceFile = normalizeInventoryPath(sourceFile).replace(/^\/+/, '');
  const sourcePath = normalizedSourceRoot ? `${normalizedSourceRoot}/${normalizedSourceFile}` : normalizedSourceFile;

  return pathPosix.relative(docDir, sourcePath);
}
