import type { MakaioContext } from '@makaio/core';

/**
 * Read and sanitize allowedDirectories from execution constraints.
 * @param constraints - Optional execution constraints map
 * @returns Array of valid directory strings, or undefined when not provided
 */
export function getAllowedDirectoriesFromConstraints(constraints?: MakaioContext['constraints']): string[] | undefined {
  const candidate = constraints?.['allowedDirectories'];
  if (!Array.isArray(candidate)) {
    return undefined;
  }
  return candidate.filter((entry): entry is string => typeof entry === 'string');
}
