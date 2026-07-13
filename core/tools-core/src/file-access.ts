import path from 'node:path';

/**
 * Compiled file access rules injected into tool execution context constraints.
 */
export interface FileAccessRules {
  /**
   * Directory allow-list.
   * - `undefined`: no directory restriction
   * - `[]`: deny all filesystem paths
   * - non-empty array: allow-list to these directories
   */
  readonly allowedDirectories?: readonly string[];

  /**
   * Sync predicate that returns true when the absolute path is denied.
   * @param absolutePath - Normalized absolute path to test
   */
  readonly isDenied: (absolutePath: string) => boolean;
}

/**
 * Provides filesystem access rules for a given working directory.
 * @param cwd - Absolute working directory
 * @param allowedDirectories - Directory allow-list from the active execution policy (`[]` denies all paths)
 */
export type FileAccessRuleProvider = (cwd: string, allowedDirectories?: readonly string[]) => Promise<FileAccessRules>;

/** Constraints key for FileAccessRules in MakaioContext.constraints. */
export const FILE_ACCESS_RULES_KEY = 'fileAccessRules' as const;

/** Known filesystem tool names mapped to candidate arg keys, checked in order. */
const TOOL_PATH_ARGS: ReadonlyMap<string, readonly string[]> = new Map([
  ['read_file', ['path', 'file_path']],
  ['write_file', ['path', 'file_path']],
  ['delete_file', ['path']],
  ['list_directory', ['path']],
  ['Read', ['path', 'file_path']],
  ['Write', ['path', 'file_path']],
  ['Edit', ['path', 'file_path']],
  ['MultiEdit', ['path', 'file_path']],
  ['create_file', ['path', 'file_path']],
]);

/**
 * Extract the target file path from a filesystem tool call's arguments.
 *
 * Returns the resolved absolute path, or `null` if the tool is not a known
 * filesystem tool or the args don't contain the expected path field.
 * @param toolName - Name of the tool being called
 * @param args - Tool arguments record
 * @param cwd - Working directory to resolve relative paths against
 * @returns Absolute path to the target file, or `null` if not applicable
 */
export function extractToolFilePath(
  toolName: string | undefined,
  args: Record<string, unknown> | undefined,
  cwd: string,
): string | null {
  if (!toolName || !args) return null;
  const argKeys = TOOL_PATH_ARGS.get(toolName);
  if (!argKeys) return null;
  const rawPath = argKeys
    .map((key) => args[key])
    .find((value): value is string => typeof value === 'string' && value.length > 0);
  if (!rawPath) return null;
  return path.resolve(cwd, rawPath);
}
