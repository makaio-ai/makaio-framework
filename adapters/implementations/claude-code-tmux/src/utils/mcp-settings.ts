/**
 * MCP settings helper for the Claude Code tmux adapter.
 *
 * Provides thin wrappers around the `config.mcpServers.*` bus subjects exposed
 * by the Claude Code client service. All writes are delegated to the service
 * handler, which owns atomic file I/O for `.mcp.json`.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { CallContext } from '@makaio/contracts';
import { ClaudeCodeClientSubjects } from '@makaio/client-claude-code/runtime';
import type { ClaudeCodeMcpServerEntry } from '@makaio/client-claude-code';

/**
 * Add (or replace) an MCP server entry in the project's `.mcp.json`.
 *
 * Delegates to `config.mcpServers.add` on the supplied bus when the Claude Code
 * client service is present. The operation is idempotent: when a server with
 * the same `name` and structurally equal definition already exists, no write
 * is performed.
 * @param bus - Adapter carrier bus used to send the request.
 * @param call - Call context of the handled message.
 * @param projectDir - Absolute path to the project directory containing `.mcp.json`.
 * @param name - Logical server name (key in the `mcpServers` map).
 * @param server - MCP server definition to persist.
 * @returns `true` when a config-service handler processed the request.
 */
export async function addMcpServerToProject(
  bus: Pick<IMakaioBus, 'requestOptional'>,
  call: CallContext,
  projectDir: string,
  name: string,
  server: ClaudeCodeMcpServerEntry,
): Promise<boolean> {
  const result = await bus.requestOptional(call, ClaudeCodeClientSubjects.config.mcpServers.add, {
    projectDir,
    name,
    server,
  });
  return result.handled;
}

/**
 * Remove an MCP server entry from the project's `.mcp.json`.
 *
 * Delegates to `config.mcpServers.remove` on the supplied bus when the Claude Code
 * client service is present. Idempotent — no error is thrown when the named
 * server does not exist.
 * @param bus - Adapter carrier bus used to send the request.
 * @param call - Call context for the removal.
 * @param projectDir - Absolute path to the project directory containing `.mcp.json`.
 * @param name - Logical server name to remove.
 * @returns `true` when a config-service handler processed the request.
 */
export async function removeMcpServerFromProject(
  bus: Pick<IMakaioBus, 'requestOptional'>,
  call: CallContext,
  projectDir: string,
  name: string,
): Promise<boolean> {
  const result = await bus.requestOptional(call, ClaudeCodeClientSubjects.config.mcpServers.remove, {
    projectDir,
    name,
  });
  return result.handled;
}
