interface ViteDevServerLike {
  readonly middlewares: {
    use(
      path: string,
      handler: (req: unknown, res: { setHeader(name: string, value: string): void; end(body: string): void }) => void,
    ): void;
  };
}

interface ViteHealthPlugin {
  readonly name: string;
  configureServer(server: ViteDevServerLike): void;
}

/**
 * Create the Vite dev middleware that mirrors the hosted `/health` route.
 * @returns Vite-compatible plugin that serves the desktop health response.
 */
export function createDevHealthPlugin(): ViteHealthPlugin {
  return {
    name: 'makaio-health',
    configureServer(server) {
      server.middlewares.use('/health', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, auth: false }));
      });
    },
  };
}
