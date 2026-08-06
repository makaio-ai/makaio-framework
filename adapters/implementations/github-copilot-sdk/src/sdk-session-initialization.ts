/** Error emitted when connector shutdown invalidates SDK session initialization. */
export const COPILOT_SESSION_INITIALIZATION_CANCELLED = 'GitHub Copilot session initialization was cancelled';

/** Inputs required to create a Copilot SDK session without publishing it. */
export interface CopilotSdkSession {
  /** Release the SDK session. */
  destroy(): Promise<void>;
}

/** Minimal SDK client surface required by session initialization. */
export interface CopilotSdkSessionClient<TSessionConfig, TSession extends CopilotSdkSession> {
  /** Start the client process or connection. */
  start(): Promise<void>;
  /** Create a session with the supplied configuration. */
  createSession(sessionConfig: TSessionConfig): Promise<TSession>;
}

export interface CopilotSdkSessionInitializationOptions<TSessionConfig, TSession extends CopilotSdkSession> {
  /** SDK client that owns the session. */
  client: CopilotSdkSessionClient<TSessionConfig, TSession>;
  /** Configuration passed to the SDK session factory. */
  sessionConfig: TSessionConfig;
  /** Reports whether terminal shutdown began while an SDK operation was pending. */
  isClosing: () => boolean;
}

/**
 * Start the SDK client and create an unpublished SDK session.
 *
 * Shutdown is checked after every awaited resource-creation step. A session
 * created after shutdown began is destroyed before cancellation is reported,
 * so it cannot escape the provisional initialization flight.
 * @param options - Client, session configuration, and shutdown latch
 * @returns The live SDK session when initialization remains current
 * @throws When shutdown begins during client startup or session creation
 */
export async function initializeCopilotSdkSession<TSessionConfig, TSession extends CopilotSdkSession>(
  options: CopilotSdkSessionInitializationOptions<TSessionConfig, TSession>,
): Promise<TSession> {
  await options.client.start();
  if (options.isClosing()) {
    throw new Error(COPILOT_SESSION_INITIALIZATION_CANCELLED);
  }

  const sdkSession = await options.client.createSession(options.sessionConfig);
  if (options.isClosing()) {
    await sdkSession.destroy();
    throw new Error(COPILOT_SESSION_INITIALIZATION_CANCELLED);
  }
  return sdkSession;
}
