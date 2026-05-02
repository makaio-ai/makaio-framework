import type { MakaioContext } from '@makaio/core';

/**
 * Checks if a file or directory name indicates a hidden item.
 * Uses cross-platform heuristic: names starting with '.' are hidden.
 *
 * Note: On Windows, true hidden files have a hidden attribute that requires
 * additional system calls to detect. This function uses a simplified approach
 * that works consistently across platforms for Unix-style hidden files.
 * @param name - File or directory name (not full path)
 * @param _context - Makaio context (reserved for future platform-specific logic)
 * @returns True if the item appears to be hidden
 */
export function isHiddenName(name: string, _context: MakaioContext): boolean {
  return name.startsWith('.');
}

/**
 * Determines the path separator for the current platform.
 * @param context - Makaio context with platform info
 * @returns Path separator character
 */
export function getPathSeparator(context: MakaioContext): string {
  return context.platform === 'windows' ? '\\' : '/';
}

/**
 * Normalizes a path for display based on platform.
 * Ensures consistent separator usage for the target platform.
 * @param filePath - Path to normalize
 * @param context - Makaio context with platform info
 * @returns Path with platform-appropriate separators
 */
export function normalizePlatformPath(filePath: string, context: MakaioContext): string {
  if (context.platform === 'windows') {
    return filePath.replace(/\//g, '\\');
  }
  return filePath.replace(/\\/g, '/');
}
