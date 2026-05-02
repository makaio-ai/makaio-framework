/**
 * MCP server command.
 *
 * Registers the built-in `mcp-server` command which starts an MCP stdio bridge
 * backed by the Makaio bus. The bridge reads MCP JSON-RPC messages from stdin
 * and dispatches tool calls through the connected bus.
 *
 * UX shape:
 * ```
 * makaio mcp-server   # Start the MCP stdio bridge
 * ```
 *
 * The command requires an active bus connection. If the server is unreachable
 * the command fails immediately with a contextual error message.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { startMcpBridge } from '@makaio/app-mcp-server';
import { formatConnectionError } from './connection-error.js';
import type { CommandInstance } from './command-tree.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runtime context injected when registering the MCP server command.
 *
 * The bus is pre-connected and shared across the entire CLI invocation. When
 * `null` (server unreachable, auth failure), the command still registers for
 * `--help` visibility but the action fails with the contextual error.
 */
export interface McpServerCommandContext {
  /**
   * Pre-connected bus instance shared across the entire CLI invocation.
   * `null` when the server connection failed.
   */
  readonly bus: IMakaioBus | null;
  /**
   * Human-readable reason the bus connection failed, or `undefined` when the
   * bus connected successfully.
   */
  readonly connectionError?: string;
}

/**
 * Register the built-in `mcp-server` command on the root Commander program.
 *
 * Starts an MCP stdio bridge backed by the Makaio bus when invoked. The CLI
 * owns signal handling — SIGINT is translated to an AbortSignal which is
 * passed to {@link startMcpBridge}. The main `finally` block owns bus
 * disconnection; this command does not disconnect the bus.
 * @param program - The root Commander program to attach the command to.
 * @param ctx - Bus and error context for the current CLI invocation.
 */
export function registerMcpServerCommand(program: CommandInstance, ctx: McpServerCommandContext): void {
  program
    .command('mcp-server')
    .description('Start an MCP stdio bridge backed by the Makaio bus')
    .action(async () => {
      if (!ctx.bus) {
        process.stderr.write(`${formatConnectionError(ctx.connectionError)}\n`);
        process.exitCode = 1;
        return;
      }

      const controller = new AbortController();
      const onSigint = (): void => {
        controller.abort();
      };

      process.on('SIGINT', onSigint);

      try {
        await startMcpBridge(ctx.bus, { signal: controller.signal });
      } catch (err) {
        process.stderr.write(`mcp-server failed: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      } finally {
        process.off('SIGINT', onSigint);
      }
    });
}
