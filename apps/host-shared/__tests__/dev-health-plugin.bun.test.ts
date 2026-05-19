import { describe, expect, it, mock } from 'bun:test';
import { createDevHealthPlugin } from '../src/dev-health-plugin.js';

describe('createDevHealthPlugin', () => {
  it('registers a Vite middleware for the desktop health response', () => {
    const use = mock();
    const plugin = createDevHealthPlugin();

    plugin.configureServer({ middlewares: { use } });

    expect(use).toHaveBeenCalledOnce();
    const [path, handler] = use.mock.calls[0] as [
      string,
      (req: unknown, res: { setHeader(name: string, value: string): void; end(body: string): void }) => void,
    ];
    const res = { setHeader: mock(), end: mock() };
    handler({}, res);

    expect(path).toBe('/health');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ ok: true, auth: false }));
  });
});
