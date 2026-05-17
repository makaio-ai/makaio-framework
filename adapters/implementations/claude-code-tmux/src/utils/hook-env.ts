/**
 * Resolve runtime environment variables for Claude Code hook subprocesses.
 * @packageDocumentation
 */

/**
 * Quote a value for POSIX shell assignment syntax.
 * @param value - Raw environment variable value.
 * @returns Single-quoted shell-safe value.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolve runtime env pairs for hook/statusline subprocesses in dev mode.
 * @param env - Environment snapshot to read from.
 * @returns Environment pairs to prepend to generated commands, or undefined.
 */
export function resolveHookEnvPairs(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const configFile = env['MAKAIO_CONFIG_FILE'];
  if (!configFile) {
    return undefined;
  }

  const pairs = [`MAKAIO_CONFIG_FILE=${shellQuote(configFile)}`];
  const home = env['MAKAIO_HOME'];
  if (home) {
    pairs.push(`MAKAIO_HOME=${shellQuote(home)}`);
  }
  return pairs;
}
