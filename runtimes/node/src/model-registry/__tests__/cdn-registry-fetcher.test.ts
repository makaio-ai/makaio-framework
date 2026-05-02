import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CdnRegistryFetcher } from '../cdn-registry-fetcher.js';

const registryYaml = `\
$schema: makaio/model-registry/v2
updatedAt: "2026-01-30T12:00:00.000Z"
labs:
  test:
    name: Test Lab
    models:
      - name: test-model
        friendlyName: Test Model
        contextWindowSize: 8000
        labId: test
providers:
  test:
    name: Test Provider
    models:
      test-model: {}
`;

describe('CdnRegistryFetcher', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) reject(error);
              else resolve();
            });
          }),
      ),
    );
    servers.length = 0;
  });

  it('requires an explicit registry URL', () => {
    expect(() => new CdnRegistryFetcher('')).toThrow('requires a non-empty registry URL');
    expect(() => new CdnRegistryFetcher('   ')).toThrow('requires a non-empty registry URL');
  });

  it('requires a syntactically valid HTTP(S) registry URL', () => {
    expect(() => new CdnRegistryFetcher('not a url')).toThrow('requires a valid registry URL');
    expect(() => new CdnRegistryFetcher('file:///tmp/model-registry.yaml')).toThrow('requires an HTTP(S) registry URL');
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid timeout %s', (timeoutMs) => {
    expect(() => new CdnRegistryFetcher('https://example.com/model-registry.yaml', timeoutMs)).toThrow(
      'requires a positive finite timeoutMs',
    );
  });

  it('fetches and parses YAML from the injected registry URL', async () => {
    const { server, url } = await startRegistryServer({ body: registryYaml });
    servers.push(server);

    const registry = await new CdnRegistryFetcher(url).fetch();

    expect(registry.labs.test?.models[0]?.name).toBe('test-model');
    expect(registry.providers.test?.name).toBe('Test Provider');
  });

  it('trims the registry URL before fetching', async () => {
    const { server, url } = await startRegistryServer({ body: registryYaml });
    servers.push(server);

    const registry = await new CdnRegistryFetcher(`  ${url}  `).fetch();

    expect(registry.providers.test?.name).toBe('Test Provider');
  });

  it('throws with status info when the server returns a non-OK HTTP status', async () => {
    const { server, url } = await startRegistryServer({ statusCode: 404, statusText: 'Not Found', body: '' });
    servers.push(server);

    await expect(new CdnRegistryFetcher(url).fetch()).rejects.toThrow(/Failed to fetch model registry: 404/);
  });

  it('throws with status info when the server returns a 500 error', async () => {
    const { server, url } = await startRegistryServer({
      statusCode: 500,
      statusText: 'Internal Server Error',
      body: 'error',
    });
    servers.push(server);

    await expect(new CdnRegistryFetcher(url).fetch()).rejects.toThrow(/Failed to fetch model registry: 500/);
  });

  it('throws a timeout error when the request exceeds the configured timeout', async () => {
    // Server that never responds — simulates a hanging connection.
    const server = createServer((_request, _response) => {
      // Intentionally left blank: never writes a response.
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    servers.push(server);

    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/model-registry.yaml`;

    await expect(new CdnRegistryFetcher(url, 50).fetch()).rejects.toThrow(
      /Failed to fetch model registry: timed out after 50ms/,
    );
  });

  it('throws a schema validation error when the server returns malformed YAML', async () => {
    const { server, url } = await startRegistryServer({ body: '{ not_a_valid_registry: true }' });
    servers.push(server);

    await expect(new CdnRegistryFetcher(url).fetch()).rejects.toThrow();
  });
});

/**
 * Options for the local HTTP test server.
 */
interface RegistryServerOptions {
  /** Response body. */
  body: string;
  /** HTTP status code (default 200). */
  statusCode?: number;
  /** HTTP status message (default 'OK'). */
  statusText?: string;
}

/**
 * Start a local HTTP server that serves the provided YAML.
 * @param options - Server response options.
 * @returns The server and injectable URL.
 */
async function startRegistryServer(options: RegistryServerOptions): Promise<{ server: Server; url: string }> {
  const { body, statusCode = 200, statusText = 'OK' } = options;

  const server = createServer((_request, response) => {
    response.writeHead(statusCode, statusText, { 'content-type': 'application/yaml' });
    response.end(body);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}/model-registry.yaml` };
}
