/** Tool-result block emitted by Claude's user-event stream. */
type ClaudeToolResultBlock = {
  type?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

/** Resolved metadata from the normalized tool-call tracker. */
type ResolvedToolCall = {
  toolName: string;
  args?: Record<string, unknown>;
  toolCallId: string;
};

/** Dependencies for routing a Claude tool result with its original message owner. */
export interface ClaudeToolResultRouter {
  messageId?: string;
  payload: {
    message?: { content?: unknown };
    tool_use_result?: { stdout?: string; stderr?: string } | string;
  };
  resolveToolOutput: (messageId: string, output: string, nativeId?: string) => Promise<ResolvedToolCall>;
  emitToolCompleted: (input: {
    messageId: string;
    toolName: string;
    args?: Record<string, unknown>;
    result: { content: unknown };
    success: boolean;
    toolCallId: string;
  }) => Promise<void>;
  emitToolStepFinished: (input: {
    blockIndex: number;
    toolCallId: string;
    output: string;
    isError: boolean;
  }) => Promise<void>;
  consumeToolBlockIndex: (nativeId: string | undefined) => number;
}

/**
 * Route Claude user-event tool results without deriving ownership from mutable
 * agent state. Events with no captured originating message are intentionally
 * ignored because they cannot be correlated safely after supersession.
 * @param router - Message-owned routing dependencies.
 */
export async function routeClaudeToolResults(router: ClaudeToolResultRouter): Promise<void> {
  const { messageId } = router;
  if (messageId === undefined) return;
  const content = router.payload.message?.content;
  const contentBlocks = Array.isArray(content) ? content : content ? [content] : [];
  for (const block of contentBlocks) {
    if (!isToolResultBlock(block)) continue;
    const nativeId = block.tool_use_id;
    const output = getToolResultOutput(router.payload.tool_use_result);
    const resolved = await router.resolveToolOutput(messageId, output, nativeId);
    await router.emitToolCompleted({
      messageId,
      toolName: resolved.toolName,
      args: resolved.args,
      result: { content: block.content ?? {} },
      success: !block.is_error,
      toolCallId: resolved.toolCallId,
    });
    await router.emitToolStepFinished({
      blockIndex: router.consumeToolBlockIndex(nativeId),
      toolCallId: resolved.toolCallId,
      output,
      isError: block.is_error ?? false,
    });
  }
}

/**
 * @param block - Unknown stream value.
 * @returns Whether an unknown stream value is a Claude tool-result block.
 */
function isToolResultBlock(block: unknown): block is ClaudeToolResultBlock {
  return typeof block === 'object' && block !== null && (block as ClaudeToolResultBlock).type === 'tool_result';
}

/**
 * @param result - Structured or string Claude tool-result payload.
 * @returns Normalized text from Claude's structured or string tool-result payload.
 */
function getToolResultOutput(result: ClaudeToolResultRouter['payload']['tool_use_result']): string {
  if (typeof result === 'string') return result;
  return [result?.stdout, result?.stderr].filter(Boolean).join('\n');
}
