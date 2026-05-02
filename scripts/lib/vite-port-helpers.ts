/**
 * Shared port-parsing helpers for Vite dev-server configuration.
 *
 * Both the Electron renderer config and the standalone web-app config need to
 * parse a `--port` / `-p` CLI argument and validate port numbers. This module
 * houses the single canonical implementation so neither config duplicates it.
 * @packageDocumentation
 */

/**
 * Check whether a number is a valid TCP port (integer in 1–65 535).
 * @param n - Candidate port number.
 * @returns `true` when `n` is a usable port.
 */
export function isValidPort(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n <= 65_535;
}

/**
 * Parse the dev-server port from Vite CLI arguments.
 *
 * Supports all four forms that Vite itself accepts:
 * - `--port 6252`
 * - `--port=6252`
 * - `-p 6252`
 * - `-p=6252`
 * @param argv - Raw process arguments (e.g. `process.argv`).
 * @returns The parsed port when present and valid, otherwise `undefined`.
 */
export function parseCliPortArg(argv: readonly string[]): number | undefined {
  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg !== '--port' && arg !== '-p' && !arg.startsWith('--port=') && !arg.startsWith('-p=')) {
      continue;
    }
    const rawValue = arg === '--port' || arg === '-p' ? argv[idx + 1] : arg.slice(arg.indexOf('=') + 1);
    const port = Number(rawValue);
    if (isValidPort(port)) {
      return port;
    }
  }
  return undefined;
}
