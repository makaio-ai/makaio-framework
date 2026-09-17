/**
 * End-to-end test through the real composition seam.
 *
 * Every other suite exercises one layer in isolation. This one wires the layers
 * the way the host does: the exported extension manifest, a real bus with the
 * gateway namespace registered, a real {@link CredentialResolver}, a real
 * shutdown signal, and the manifest's own `http.mount` against a parent Hono
 * app. It is the only test that would fail if `create`, `init`, `mount`, or the
 * namespace registration stopped agreeing with each other.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import type { CredentialResolver } from '@makaio/contracts';
import type { CredentialRef } from '@makaio/contracts/config';
import type { ExtensionService, ExtensionToken, NodeExtensionContext } from '@makaio/contracts/extension';
import { Hono } from 'hono';
import { gatewayExtension } from '../index.js';
import { GatewayNamespace, GatewaySubjects } from '../contracts/index.js';
import type { RequestRoutedEvent } from '../contracts/schemas.js';

/** Credential reference used for the gateway access token in this suite. */
const ACCESS_TOKEN_REF = 'env:GATEWAY_ACCESS_TOKEN';
/** Plaintext the resolver returns for {@link ACCESS_TOKEN_REF}. */
const ACCESS_TOKEN = 'e2e-gateway-token';

/**
 * Real {@link CredentialResolver} backed by an in-process map.
 *
 * A stand-in for the host's resolver, not a mock of one: it implements the
 * published contract, including returning `null` for an unknown reference.
 */
class MapCredentialResolver implements CredentialResolver {
  private readonly store: ReadonlyMap<string, string>;

  /**
   * @param entries - Map from credential reference string to plaintext value.
   */
  public constructor(entries: Record<string, string>) {
    this.store = new Map(Object.entries(entries));
  }

  /**
   * Resolve a credential reference from the in-process store.
   * @param ref - Branded credential reference string.
   * @returns Plaintext value, or `null` when the reference is unknown.
   */
  public resolve(ref: CredentialRef): Promise<string | null> {
    return Promise.resolve(this.store.get(ref) ?? null);
  }
}

/** Handle for the mock upstream this suite routes to. */
interface Upstream {
  port: number;
  lastPath: string | null;
  close: () => Promise<void>;
}

/**
 * Start a mock Anthropic upstream that records the path it was called on.
 * @returns The running upstream handle.
 */
function startUpstream(): Promise<Upstream> {
  return new Promise((resolve, reject) => {
    let lastPath: string | null = null;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        lastPath = req.url ?? null;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'message', id: 'e2e' }));
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        port: addr.port,
        get lastPath() {
          return lastPath;
        },
        close: () => {
          server.closeAllConnections();
          return new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())));
        },
      });
    });
  });
}

/**
 * Build the Node extension context the host would hand to `create`.
 *
 * `identity` is opaque by design and is minted by the kernel at runtime; this
 * package deliberately carries no kernel dependency, so the test brands the
 * same frozen shape the kernel's own builder produces.
 * @param bus - Bus the extension should publish on.
 * @param config - Raw extension config value.
 * @param signal - Runtime shutdown signal.
 * @param credentials - Host-supplied credential resolver.
 * @returns A context satisfying the contract `create` is typed against.
 */
function createContext(
  bus: IMakaioBus,
  config: unknown,
  signal: AbortSignal,
  credentials: CredentialResolver,
): NodeExtensionContext<IMakaioBus> {
  return {
    bus,
    identity: Object.freeze({ extensionName: 'gateway' }) as NodeExtensionContext<IMakaioBus>['identity'],
    dataDir: '/tmp/gateway-e2e',
    machineId: 'e2e-machine',
    config,
    getService: <T>(_token: ExtensionToken<T>): T | undefined => undefined,
    tryImport: async () => null,
    signal,
    hasExtension: () => false,
    platform: process.platform,
    homedir: '/tmp',
    makaioHome: '/tmp/.makaio',
    username: 'e2e',
    credentials,
  };
}

let upstream: Upstream;
let bus: IMakaioBus;
let shutdown: AbortController;
let service: ExtensionService;
let hostApp: Hono;
/** Events observed on the bus, not through the router's injected emitter. */
let busEvents: RequestRoutedEvent[];

beforeAll(async () => {
  upstream = await startUpstream();

  // Compose exactly as the coordinator does: register the manifest's declared
  // namespaces on the bus, then call the factory with the runtime context.
  bus = createBusInstance();
  bus.registerNamespaces([GatewayNamespace]);

  busEvents = [];
  bus.on(GatewaySubjects.requestRouted, (event) => {
    busEvents.push(event.payload);
  });

  shutdown = new AbortController();
  const create = gatewayExtension.create;
  if (create === undefined) {
    throw new Error('gateway extension must expose a create() factory');
  }
  service = await create(
    createContext(
      bus,
      {
        upstreams: { anthropic: { kind: 'anthropic', url: `http://127.0.0.1:${upstream.port}` } },
        default: 'anthropic',
        rules: [{ match: 'claude-*', to: 'anthropic' }],
        accessToken: ACCESS_TOKEN_REF,
      },
      shutdown.signal,
      new MapCredentialResolver({ [ACCESS_TOKEN_REF]: ACCESS_TOKEN }),
    ),
  );

  await service.init?.();

  hostApp = new Hono();
  const mount = gatewayExtension.http?.mount;
  if (mount === undefined) {
    throw new Error('gateway extension must expose an http.mount contribution');
  }
  mount(hostApp);
});

afterAll(async () => {
  await service.destroy?.();
  shutdown.abort();
  await upstream.close();
});

describe('gateway extension composition seam', () => {
  // Reset the shared event array before each test so that no test depends on
  // side effects produced by a previous test (order independence).
  beforeEach(() => {
    busEvents = [];
  });

  it('mounts under the declared http prefix and routes a request to the upstream', async () => {
    expect(gatewayExtension.http?.prefix).toBe('/gateway');

    const response = await hostApp.fetch(
      new Request('http://localhost/gateway/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-gateway-token': ACCESS_TOKEN },
        body: JSON.stringify({ model: 'claude-opus-4-5', messages: [] }),
      }),
    );

    expect(response.status).toBe(200);
    expect(upstream.lastPath).toBe('/v1/messages');
  });

  it('publishes the requestRouted event on the real bus namespace', async () => {
    // Issue the request this test relies on rather than depending on a
    // previous test having done so. busEvents is reset in beforeEach, so
    // this test is fully isolated regardless of execution order.
    const response = await hostApp.fetch(
      new Request('http://localhost/gateway/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-gateway-token': ACCESS_TOKEN },
        body: JSON.stringify({ model: 'claude-opus-4-5', messages: [] }),
      }),
    );
    expect(response.status).toBe(200);

    // The bus emit in GatewayService is fire-and-forget; drain the microtask
    // queue before asserting so the handler has run.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(busEvents).toHaveLength(1);
    expect(busEvents[0]?.target).toBe('anthropic');
    expect(busEvents[0]?.upstream).toBe('anthropic');
    expect(busEvents[0]?.requestedModel).toBe('claude-opus-4-5');
    expect(busEvents[0]?.ruleIndex).toBe(0);
    expect(busEvents[0]?.outcome).toBe('completed');
    expect(busEvents[0]?.status).toBe(200);
  });

  it('enforces the resolved access token on the mounted app', async () => {
    const response = await hostApp.fetch(
      new Request('http://localhost/gateway/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-4-5', messages: [] }),
      }),
    );

    expect(response.status).toBe(401);
  });
});
