import type {
  Client,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
} from '@agentclientprotocol/sdk';
import type { MakaioAcpClientConfig } from './types.js';

/**
 * ACP {@link Client} implementation that bridges agent requests to Makaio infrastructure.
 *
 * Routes session updates, permission requests, filesystem operations, and terminal
 * lifecycle events to the connector-provided callbacks and optional terminal manager.
 * All optional Client methods throw a descriptive error when the corresponding
 * capability has not been configured.
 */
export class MakaioAcpClient implements Client {
  private readonly config: MakaioAcpClientConfig;

  /**
   * @param config - Callbacks and optional managers for each ACP client capability
   */
  public constructor(config: MakaioAcpClientConfig) {
    this.config = config;
  }

  /**
   * Forwards session update notifications to the connector.
   * @param params - Session notification from the agent
   * @returns Void promise resolving after the notification is processed
   */
  public async sessionUpdate(params: SessionNotification): Promise<void> {
    await this.config.onSessionUpdate(params);
  }

  /**
   * Forwards permission requests to the connector approval handler.
   * @param params - Permission request from the agent
   * @returns The user's permission decision
   */
  public async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return this.config.onRequestPermission(params);
  }

  /**
   * Forwards file read requests to the optional handler.
   * @param params - Read file request from the agent
   * @returns File contents
   */
  public async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    if (!this.config.onReadTextFile) {
      throw new Error('readTextFile not supported: no handler configured');
    }
    return this.config.onReadTextFile(params);
  }

  /**
   * Forwards file write requests to the optional handler.
   * @param params - Write file request from the agent
   * @returns Write confirmation
   */
  public async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    if (!this.config.onWriteTextFile) {
      throw new Error('writeTextFile not supported: no handler configured');
    }
    return this.config.onWriteTextFile(params);
  }

  /**
   * Creates a new terminal process via the terminal manager.
   * @param params - Terminal creation parameters from the agent
   * @returns Terminal ID for subsequent operations
   */
  public async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    if (!this.config.terminalManager) {
      throw new Error('createTerminal not supported: no terminal manager configured');
    }
    return this.config.terminalManager.createTerminal(params);
  }

  /**
   * Retrieves the current output of a managed terminal.
   * @param params - Terminal output request from the agent
   * @returns Current buffered output and truncation status
   */
  public async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    if (!this.config.terminalManager) {
      throw new Error('terminalOutput not supported: no terminal manager configured');
    }
    return this.config.terminalManager.getOutput(params);
  }

  /**
   * Waits for a managed terminal to exit.
   * @param params - Wait for exit request from the agent
   * @returns Exit code and terminating signal
   */
  public async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    if (!this.config.terminalManager) {
      throw new Error('waitForTerminalExit not supported: no terminal manager configured');
    }
    return this.config.terminalManager.waitForExit(params);
  }

  /**
   * Kills a managed terminal process without releasing it.
   * @param params - Kill terminal request from the agent
   * @returns Empty kill response
   */
  public async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    if (!this.config.terminalManager) {
      throw new Error('killTerminal not supported: no terminal manager configured');
    }
    return this.config.terminalManager.killTerminal(params);
  }

  /**
   * Releases a managed terminal and frees all associated resources.
   * @param params - Release terminal request from the agent
   * @returns Empty release response
   */
  public async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    if (!this.config.terminalManager) {
      throw new Error('releaseTerminal not supported: no terminal manager configured');
    }
    return this.config.terminalManager.releaseTerminal(params);
  }
}
