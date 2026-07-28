/**
 * HTTP hook bridge for conformance testing.
 *
 * Claude Code hooks fire shell commands that run in separate processes.
 * In tests, those processes cannot reach the vitest worker's bus directly.
 * This module provides an HTTP server that receives hook payloads via POST
 * and re-emits them on the in-process {@link MakaioBus}, bridging the gap.
 *
 * **PreToolUse tool approval:** When a PreToolUse hook fires, the bridge
 * emits an `AgentSubjects.toolApprove` request on the bus and waits for
 * the response. The decision is returned to Claude Code as JSON on stdout
 * (via the curl response body), allowing Claude Code to block or allow
 * the tool use.
 *
 * **Hook command format:** Each event is wired as a `curl` call:
 * ```
 * curl -s -X POST http://localhost:<port>/hook/<eventName> -d @-
 * ```
 * Claude Code pipes JSON to stdin; `-d @-` reads the body from stdin.
 * @packageDocumentation
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';
import {
  ClaudeCodeClientSubjects,
  CLAUDE_CODE_HOOK_PRE_TOOL_USE,
  createDenyEffect,
  renderClaudeCodeNativeResponse,
} from '@makaio/client-claude-code/runtime';
import { isRecord } from '@makaio/utils';

/**
 * Agent context for correlating hook events to Makaio agent instances.
 *
 * Registered via {@link HookBridgeHandle.registerAgentContext} when a
 * connector is created; looked up by `session_id` from the hook payload.
 */
export interface AgentContext {
  readonly agentId: string;
  readonly adapterId: string;
  readonly adapterName: string;
  readonly adapterSessionId: string;
  readonly projectDir: string;
}

/**
 * Handle returned by {@link startHookBridge}.
 */
export interface HookBridgeHandle {
  /** Port the HTTP server is listening on. */
  readonly port: number;
  /**
   * Register an agent context so PreToolUse hooks can emit toolApprove
   * with the correct agent identity fields.
   * @param ctx - Agent context to register.
   */
  registerAgentContext: (ctx: AgentContext) => void;
  /** Gracefully close the bridge server. */
  close: () => Promise<void>;
}

/**
 * Response body used when the bridge contributes no permission decision.
 *
 * An empty JSON object is not the same thing as a native approve: it leaves
 * the decision entirely to the Claude Code CLI, which is the behavior the
 * approval path has always had.
 */
const NO_DECISION_BODY = '{}';

/** Module-level agent context map: claudeSessionId → AgentContext. */
const agentContextMap = new Map<string, AgentContext>();
const agentContextByProjectDir = new Map<string, AgentContext>();

/**
 * Start an HTTP hook bridge server on a random port.
 *
 * Routes `POST /hook/:eventName` — reads the JSON body and either:
 * - **PreToolUse**: emits `AgentSubjects.toolApprove`, waits for response,
 *   returns Claude Code hook decision JSON.
 * - **Other hooks**: emits `client:claude-code.hook.received` on the bus.
 *
 * Routes `POST /statusline` — reads Claude Code statusline stdin and emits
 * `client:claude-code.statusline.received` on the bus.
 * @returns Handle with port number, context registration, and close function.
 */
export async function startHookBridge(): Promise<HookBridgeHandle> {
  const server = createServer(handleRequest);

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve(addr.port);
      } else {
        reject(new Error('Failed to bind hook bridge server'));
      }
    });
    server.on('error', reject);
  });

  return {
    port,
    registerAgentContext: (ctx) => {
      agentContextMap.set(ctx.adapterSessionId, ctx);
      agentContextByProjectDir.set(ctx.projectDir, ctx);
    },
    close: async () => {
      agentContextMap.clear();
      agentContextByProjectDir.clear();
      await closeServer(server);
    },
  };
}

/**
 * Resolve the registered agent context for a project directory.
 * @param projectDir - Project directory used by the connector.
 * @returns Registered agent context, if any.
 */
export function resolveAgentContextForProject(projectDir: string): AgentContext | undefined {
  return agentContextByProjectDir.get(projectDir);
}

/**
 * Route incoming HTTP requests.
 * @param req - Incoming HTTP request.
 * @param res - Server response.
 */
function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }

  const hookMatch = req.url?.match(/^\/hook\/(.+)$/);
  if (hookMatch) {
    const eventName = decodeURIComponent(hookMatch[1]!);
    collectBody(req)
      .then(async (body) => {
        const payload = parseJsonSafe(body);

        if (eventName === CLAUDE_CODE_HOOK_PRE_TOOL_USE) {
          const decisionBody = await handlePreToolUseApproval(payload);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(decisionBody);
          return;
        }

        console.log(
          `[claude-code-tmux:test] hook received eventName=${eventName} sessionId=${String(payload.session_id ?? '')}`,
        );
        await MakaioBus.emit(ClaudeCodeClientSubjects.hook.received, {
          eventName,
          receivedAt: Date.now(),
          payload,
        });
        res.writeHead(200);
        res.end();
      })
      .catch(() => {
        res.writeHead(500);
        res.end();
      });
    return;
  }

  if (req.url !== '/statusline') {
    res.writeHead(404);
    res.end();
    return;
  }

  collectBody(req)
    .then(async (body) => {
      const payload = parseJsonSafe(body);
      await MakaioBus.emit(ClaudeCodeClientSubjects.statusline.received, payload);
      res.writeHead(200);
      res.end();
    })
    .catch(() => {
      res.writeHead(500);
      res.end();
    });
}

/**
 * Render a native Claude Code PreToolUse denial body.
 *
 * The native shape is owned by the Claude Code client; rendering through its
 * renderer keeps this bridge from drifting away from what the client emits at
 * runtime.
 * @param reason - Human-readable reason reported to the Claude Code CLI.
 * @returns Serialized native hook output for the HTTP response body.
 */
function renderDenyBody(reason: string): string {
  return renderClaudeCodeNativeResponse(CLAUDE_CODE_HOOK_PRE_TOOL_USE, [createDenyEffect(reason)]).stdout;
}

/**
 * Handle a PreToolUse hook by requesting tool approval on the bus.
 *
 * Looks up the agent context from the `session_id` in the payload, emits
 * `AgentSubjects.toolApprove`, and translates the response into the
 * Claude Code hook decision format.
 * @param payload - Raw PreToolUse hook payload from Claude Code.
 * @returns Serialized Claude Code hook decision body for stdout.
 */
async function handlePreToolUseApproval(payload: Record<string, unknown>): Promise<string> {
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined;
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const toolUseId = typeof payload.tool_use_id === 'string' ? payload.tool_use_id : '';
  const toolInput =
    typeof payload.tool_input === 'object' && payload.tool_input !== null
      ? (payload.tool_input as Record<string, unknown>)
      : {};

  const ctx = sessionId ? agentContextMap.get(sessionId) : undefined;
  if (!ctx) {
    // Also emit as a regular hook so the turn state machine still advances.
    await emitRawHook(CLAUDE_CODE_HOOK_PRE_TOOL_USE, payload);
    return renderDenyBody('Missing agent context for PreToolUse approval');
  }

  // Also emit as a regular hook so the connector's onPreToolUse fires.
  await emitRawHook(CLAUDE_CODE_HOOK_PRE_TOOL_USE, payload);

  try {
    const result = await MakaioBus.request(AgentSubjects.toolApprove, {
      agentId: ctx.agentId,
      adapterId: ctx.adapterId,
      adapterName: ctx.adapterName,
      adapterSessionId: ctx.adapterSessionId,
      sessionId: 'conformance-test-session',
      toolName,
      toolCallId: toolUseId,
      args: toolInput,
    });

    if (result.action === 'deny') {
      return renderDenyBody(result.message ?? 'Tool use denied by approval handler');
    }

    return NO_DECISION_BODY;
  } catch {
    return renderDenyBody(
      "Tool approval request failed, make sure that there's a handler registered for AgentSubjects.toolApprove",
    );
  }
}

/**
 * Emit a raw hook event on the global bus.
 * @param eventName - Hook event name.
 * @param payload - Raw hook payload.
 */
async function emitRawHook(eventName: string, payload: Record<string, unknown>): Promise<void> {
  console.log(
    `[claude-code-tmux:test] hook received eventName=${eventName} sessionId=${String(payload.session_id ?? '')}`,
  );
  await MakaioBus.emit(ClaudeCodeClientSubjects.hook.received, {
    eventName,
    receivedAt: Date.now(),
    payload,
  });
}

/**
 * Collect the full request body as a UTF-8 string.
 * @param req - Incoming HTTP request.
 * @returns The raw body text.
 */
function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * Parse a JSON string as an object, returning `{}` on failure (fail-open).
 * @param text - Raw JSON text.
 * @returns Parsed object or empty object.
 */
function parseJsonSafe(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through
  }
  return {};
}

/**
 * Gracefully close the HTTP server.
 * @param server - HTTP server to close.
 */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
