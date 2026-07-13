import type * as http from 'node:http';

/**
 * Close an HTTP server while tolerating already-stopped state.
 * @param httpServer - HTTP server instance to close.
 * @returns Promise that resolves when close completes.
 */
export async function closeHttpServerSafely(httpServer: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/**
 * Start listening and resolve the assigned port, cleaning up on failure.
 * @param httpServer - Node HTTP server.
 * @param requestedPort - Port to bind (0 = auto).
 * @param onListenFailure - Cleanup callback for listen errors.
 * @returns Resolved bound port.
 */
export async function listenForHttpPort(
  httpServer: http.Server,
  requestedPort: number,
  onListenFailure: (error: Error) => Promise<void>,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const failStartup = (error: Error): void => {
      httpServer.off('error', onError);
      void onListenFailure(error).then(
        () => reject(error),
        (cleanupError: unknown) =>
          reject(new AggregateError([error, cleanupError], 'Failed during MCP server startup')),
      );
    };

    const onError = (error: Error): void => failStartup(error);

    httpServer.once('error', onError);
    try {
      httpServer.listen(requestedPort, '127.0.0.1', () => {
        const address = httpServer.address();
        if (!address || typeof address === 'string') {
          failStartup(new Error('Unexpected server address format'));
          return;
        }
        httpServer.off('error', onError);
        resolve(address.port);
      });
    } catch (error) {
      failStartup(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
