import { describe, expect, it, vi } from 'vitest';
import { viteExtensionDevPlugin, type ExtensionDevEntry } from './vite-extension-dev-plugin.js';

/** Shared middleware type extracted from the plugin's configureServer handler. */
type Middleware = (
  req: { url?: string },
  res: { setHeader: (name: string, value: string) => void; end: (body: string) => void },
  next: (error?: unknown) => void,
) => Promise<void>;

/** Stable URL used as an additional first-party browser entry in tests. */
const FIRST_PARTY_BROWSER_URL = '/extensions/first-party/browser/index.js';
/** Absolute path used as a stable first-party browser entry in tests. */
const FIRST_PARTY_BROWSER_ENTRY = '/abs/first-party/browser.ts';

/**
 * Builds a plugin, registers it against a fake Vite server, and returns the
 * first middleware registered via `server.middlewares.use`.
 * @param transformRequest - Mock implementation of `server.transformRequest`.
 * @param extensionDevEntries - Optional extension dev entries to pass to the plugin.
 * @param additionalEntries - Optional additional entries keyed by URL path.
 * @returns The extracted middleware function.
 */
function buildMiddleware(
  transformRequest: ReturnType<typeof vi.fn>,
  extensionDevEntries?: ReadonlyArray<ExtensionDevEntry>,
  additionalEntries?: Readonly<Record<string, string>>,
): Middleware {
  const middlewares = { use: vi.fn() };

  const plugin = viteExtensionDevPlugin(
    extensionDevEntries !== undefined || additionalEntries !== undefined
      ? { extensionDevEntries, additionalEntries }
      : undefined,
  );
  const configureServer = plugin.configureServer as (server: unknown) => void;
  configureServer({ middlewares, transformRequest });

  const middleware = middlewares.use.mock.calls[0]?.[0] as Middleware | undefined;
  expect(middleware).toBeTypeOf('function');
  return middleware!;
}

describe('viteExtensionDevPlugin', () => {
  it('transforms extension source files using the absolute source path', async () => {
    const transformRequest = vi.fn().mockResolvedValue({ code: 'export default {};' });
    const middleware = buildMiddleware(transformRequest, undefined, {
      [FIRST_PARTY_BROWSER_URL]: FIRST_PARTY_BROWSER_ENTRY,
    });

    const req = { url: FIRST_PARTY_BROWSER_URL };
    const res = { setHeader: vi.fn(), end: vi.fn() };
    const next = vi.fn();

    await middleware(req, res, next);

    expect(transformRequest).toHaveBeenCalledTimes(1);
    expect(transformRequest.mock.calls[0]?.[0]).toBe(FIRST_PARTY_BROWSER_ENTRY);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/javascript');
    expect(res.end).toHaveBeenCalledWith('export default {};');
    expect(next).not.toHaveBeenCalled();
  });

  it('falls through to next() for an unknown URL', async () => {
    const transformRequest = vi.fn();
    const middleware = buildMiddleware(transformRequest);

    const req = { url: '/unknown' };
    const res = { setHeader: vi.fn(), end: vi.fn() };
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(transformRequest).not.toHaveBeenCalled();
  });

  it('strips the query string before looking up the extension map', async () => {
    const transformRequest = vi.fn().mockResolvedValue({ code: 'export default {};' });
    const middleware = buildMiddleware(transformRequest, undefined, {
      [FIRST_PARTY_BROWSER_URL]: FIRST_PARTY_BROWSER_ENTRY,
    });

    const req = { url: `${FIRST_PARTY_BROWSER_URL}?t=12345` };
    const res = { setHeader: vi.fn(), end: vi.fn() };
    const next = vi.fn();

    await middleware(req, res, next);

    expect(transformRequest).toHaveBeenCalledTimes(1);
    expect(transformRequest.mock.calls[0]?.[0]).toBe(FIRST_PARTY_BROWSER_ENTRY);
    expect(next).not.toHaveBeenCalled();
  });

  it('falls through to next() when transformRequest returns null', async () => {
    const transformRequest = vi.fn().mockResolvedValue(null);
    // additionalEntries must be present so the URL lookup matches and
    // transformRequest is actually called (otherwise the middleware exits early
    // on the URL-miss branch and the null-return path is never exercised).
    const middleware = buildMiddleware(transformRequest, undefined, {
      [FIRST_PARTY_BROWSER_URL]: FIRST_PARTY_BROWSER_ENTRY,
    });

    const req = { url: FIRST_PARTY_BROWSER_URL };
    const res = { setHeader: vi.fn(), end: vi.fn() };
    const next = vi.fn();

    await middleware(req, res, next);

    expect(transformRequest).toHaveBeenCalledTimes(1);
    expect(transformRequest.mock.calls[0]?.[0]).toBe(FIRST_PARTY_BROWSER_ENTRY);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(res.end).not.toHaveBeenCalled();
  });

  it('delegates to next(error) when transformRequest rejects', async () => {
    const transformError = new Error('transform failed');
    const transformRequest = vi.fn().mockRejectedValue(transformError);
    const middleware = buildMiddleware(transformRequest, undefined, {
      [FIRST_PARTY_BROWSER_URL]: FIRST_PARTY_BROWSER_ENTRY,
    });

    const req = { url: FIRST_PARTY_BROWSER_URL };
    const res = { setHeader: vi.fn(), end: vi.fn() };
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(transformError);
    expect(res.end).not.toHaveBeenCalled();
  });

  it('zero-arg call serves no entries — caller must supply additionalEntries for first-party entries', async () => {
    // Without additionalEntries, the first-party URL falls through to next().
    const transformRequest = vi.fn();
    const middleware = buildMiddleware(transformRequest);

    const req = { url: FIRST_PARTY_BROWSER_URL };
    const res = { setHeader: vi.fn(), end: vi.fn() };
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(transformRequest).not.toHaveBeenCalled();
  });

  it('extension dev entries are served alongside first-party entries', async () => {
    const transformRequest = vi.fn().mockResolvedValue({ code: 'extension code;' });
    const extensionDevEntries: ExtensionDevEntry[] = [
      { urlPath: '/extensions/my-ext/browser/index.js', sourceAbsPath: '/abs/path/to/my-ext/index.ts' },
    ];
    const middleware = buildMiddleware(transformRequest, extensionDevEntries);

    const req = { url: '/extensions/my-ext/browser/index.js' };
    const res = { setHeader: vi.fn(), end: vi.fn() };
    const next = vi.fn();

    await middleware(req, res, next);

    expect(transformRequest).toHaveBeenCalledTimes(1);
    expect(transformRequest.mock.calls[0]?.[0]).toBe('/abs/path/to/my-ext/index.ts');
    expect(res.end).toHaveBeenCalledWith('extension code;');
    expect(next).not.toHaveBeenCalled();
  });

  it('additionalEntries win over extension dev entries on URL collision', async () => {
    // An extension dev entry with the same URL as an additional entry must NOT override it.
    const transformRequest = vi.fn().mockResolvedValue({ code: 'result;' });
    const extensionDevEntries: ExtensionDevEntry[] = [
      {
        urlPath: FIRST_PARTY_BROWSER_URL,
        sourceAbsPath: '/abs/path/to/extension-override/index.ts',
      },
    ];
    const middleware = buildMiddleware(transformRequest, extensionDevEntries, {
      [FIRST_PARTY_BROWSER_URL]: FIRST_PARTY_BROWSER_ENTRY,
    });

    const req = { url: FIRST_PARTY_BROWSER_URL };
    const res = { setHeader: vi.fn(), end: vi.fn() };
    const next = vi.fn();

    await middleware(req, res, next);

    expect(transformRequest).toHaveBeenCalledTimes(1);
    // Must use the additional (first-party) path, not the extension dev entry override
    expect(transformRequest.mock.calls[0]?.[0]).toBe(FIRST_PARTY_BROWSER_ENTRY);
  });

  it('unknown URL falls through even when extension dev entries are registered', async () => {
    const transformRequest = vi.fn();
    const extensionDevEntries: ExtensionDevEntry[] = [
      { urlPath: '/extensions/known-ext/browser/index.js', sourceAbsPath: '/abs/known.ts' },
    ];
    const middleware = buildMiddleware(transformRequest, extensionDevEntries);

    const req = { url: '/extensions/unknown/browser/index.js' };
    const res = { setHeader: vi.fn(), end: vi.fn() };
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(transformRequest).not.toHaveBeenCalled();
  });
});
