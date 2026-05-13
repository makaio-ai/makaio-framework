/**
 * Platform detection utilities for cross-platform shell execution.
 */

export type Platform = 'posix' | 'windows';

/**
 * Detects the appropriate shell for the given platform.
 * @param platform - Target platform ('posix' or 'windows')
 * @param env - Environment variables
 * @returns Shell path or name to use
 */
export function detectShell(platform: Platform, env: Record<string, string | undefined>): string {
  if (platform === 'windows') {
    return 'powershell';
  }

  // POSIX: use SHELL env var or default to bash
  const shell = env.SHELL;
  return shell && shell.length > 0 ? shell : 'bash';
}

/**
 * Returns the command-line flag(s) to pass a command string to a shell.
 *
 * This is a seam for cross-platform shell invocation:
 * - POSIX shells (bash, zsh, sh): use `-c`
 * - Windows PowerShell/pwsh: use `-Command`
 * @param shell - Shell executable name or path
 * @returns Array of args to prepend before the command string
 */
export function getShellCommandArgs(shell: string): string[] {
  const lowerShell = shell.toLowerCase();

  // Windows PowerShell variants use -Command
  if (lowerShell === 'powershell' || lowerShell === 'pwsh' || lowerShell.includes('powershell')) {
    return ['-Command'];
  }

  // POSIX shells use -c
  return ['-c'];
}

/**
 * Returns environment variables for controlling color output.
 * @param colors - Whether to enable color output
 * @returns Environment variables to set
 */
export function getColorEnv(colors: boolean): Record<string, string> {
  if (colors) {
    return {};
  }

  return {
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
}
