import type { AIModel, ProviderDefinition } from '@makaio/contracts';
import type {
  Client,
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import { createAcpConnection } from '@makaio/ai-adapters-acp-client';

/**
 * Minimal ACP client that satisfies the protocol handshake without handling any
 * real session traffic. Used only for model discovery — the subprocess is killed
 * immediately after `newSession()` returns.
 * @returns No-op ACP client
 */
function createNoopClient(): Client {
  return {
    sessionUpdate: async (_params: SessionNotification): Promise<void> => {},
    requestPermission: async (_params: RequestPermissionRequest): Promise<RequestPermissionResponse> => ({
      outcome: { outcome: 'cancelled' },
    }),
    readTextFile: async (_params: ReadTextFileRequest): Promise<ReadTextFileResponse> => ({ content: '' }),
    writeTextFile: async (_params: WriteTextFileRequest): Promise<WriteTextFileResponse> => ({}),
    createTerminal: async (_params: CreateTerminalRequest): Promise<CreateTerminalResponse> => ({
      terminalId: 'discovery-terminal',
    }),
    terminalOutput: async (_params: TerminalOutputRequest): Promise<TerminalOutputResponse> => ({
      output: '',
      truncated: false,
    }),
    waitForTerminalExit: async (_params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> => ({
      exitCode: 0,
      signal: undefined,
    }),
    killTerminal: async (_params: KillTerminalRequest): Promise<KillTerminalResponse> => ({}),
    releaseTerminal: async (_params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> => ({}),
  };
}

/**
 * Discover available models by spawning a temporary Qwen ACP subprocess.
 *
 * Runs the minimal ACP handshake (`initialize` → `newSession`) to retrieve the
 * agent's {@link SessionModelState}, then maps each {@link ModelInfo} to an
 * {@link AIModel} and tears down the subprocess.
 *
 * The `_meta.contextLimit` extension field (emitted by Qwen Code) is used for
 * `contextWindowSize`; models without it default to 0 so curated data can fill
 * the gap via the merge logic in `fetch-models.ts`.
 * @param _definition - Provider definition (unused — models come from the live ACP session)
 * @returns Array of discovered models, or null if the subprocess fails
 */
export async function fetchModels(_definition: ProviderDefinition): Promise<AIModel[] | null> {
  let handle: Awaited<ReturnType<typeof createAcpConnection>> | undefined;

  try {
    handle = await createAcpConnection(() => createNoopClient(), {
      command: 'qwen',
      args: ['--acp'],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
    });

    await handle.connection.initialize({
      clientInfo: { name: 'makaio-model-discovery', version: '0.1.0' },
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });

    const session = await handle.connection.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    if (!session.models?.availableModels) {
      return null;
    }

    return session.models.availableModels.map((model) => {
      const meta = model._meta as Record<string, unknown> | undefined;
      const contextLimit = typeof meta?.contextLimit === 'number' ? meta.contextLimit : 0;

      return {
        name: model.modelId,
        friendlyName: model.name,
        contextWindowSize: contextLimit,
        labId: 'qwen',
        metadata: model.description ? { description: model.description } : undefined,
      };
    });
  } catch {
    return null;
  } finally {
    handle?.kill();
  }
}
