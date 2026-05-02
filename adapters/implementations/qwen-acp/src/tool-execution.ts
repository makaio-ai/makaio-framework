import { MakaioBus } from '@makaio/bus-core';
import { ToolSubjects } from '@makaio/contracts';
import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

interface AcpToolExecutionContext {
  adapterId: string;
  adapterName: string;
  cwd: string;
  sessionId?: string;
  agentId: string;
  turnId?: string;
  allowedDirectories?: string[];
}

/**
 * Normalize ACP nullable numeric fields to Makaio tool input semantics.
 * @param value - ACP value that may be null
 * @returns Number when present, otherwise undefined
 */
function toOptionalNumber(value: number | null | undefined): number | undefined {
  return value ?? undefined;
}

/**
 * Execute ACP read_text_file via Makaio's tool registry.
 * @param params - ACP read request
 * @param context - Connector execution context
 * @returns ACP-compatible read response
 */
export async function executeAcpReadTextFile(
  params: ReadTextFileRequest,
  context: AcpToolExecutionContext,
): Promise<ReadTextFileResponse> {
  const result = await MakaioBus.request(ToolSubjects.execute, {
    toolName: 'read_file',
    input: {
      path: params.path,
      offset: toOptionalNumber(params.line),
      limit: toOptionalNumber(params.limit),
    },
    adapterId: context.adapterId,
    adapterName: context.adapterName,
    contextOverrides: {
      cwd: context.cwd,
      sessionId: context.sessionId,
      agentId: context.agentId,
      turnId: context.turnId,
      constraints:
        context.allowedDirectories === undefined ? undefined : { allowedDirectories: context.allowedDirectories },
    },
  });

  if (!result.success) {
    throw new Error(result.error.message);
  }

  if (!result.data || typeof result.data !== 'object' || !('content' in result.data)) {
    throw new Error(`read_file returned result without content: ${JSON.stringify(result.data)}`);
  }

  const { content } = result.data;
  if (content == null) {
    throw new Error(`read_file returned nullish content: ${JSON.stringify(result.data)}`);
  }

  if (typeof content !== 'string') {
    throw new Error(`read_file returned non-string content: ${JSON.stringify(result.data)}`);
  }

  return { content };
}

/**
 * Execute ACP write_text_file via Makaio's tool registry.
 * @param params - ACP write request
 * @param context - Connector execution context
 * @returns ACP-compatible write response
 */
export async function executeAcpWriteTextFile(
  params: WriteTextFileRequest,
  context: AcpToolExecutionContext,
): Promise<WriteTextFileResponse> {
  const result = await MakaioBus.request(ToolSubjects.execute, {
    toolName: 'write_file',
    input: {
      path: params.path,
      content: params.content,
      createDirectories: true,
    },
    adapterId: context.adapterId,
    adapterName: context.adapterName,
    contextOverrides: {
      cwd: context.cwd,
      sessionId: context.sessionId,
      agentId: context.agentId,
      turnId: context.turnId,
      constraints:
        context.allowedDirectories === undefined ? undefined : { allowedDirectories: context.allowedDirectories },
    },
  });

  if (!result.success) {
    throw new Error(result.error.message);
  }

  return {};
}
