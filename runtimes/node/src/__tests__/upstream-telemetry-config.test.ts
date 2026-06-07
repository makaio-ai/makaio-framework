import { describe, expect, it, vi } from 'vitest';
import type { BusTransport } from '@makaio/bus-core';
import { WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import {
  createUpstreamTelemetryTransport,
  resolveUpstreamTelemetryBootOptionsFromEnv,
  type UpstreamTelemetryTransportConfig,
} from '../upstream-telemetry-config.js';

function createTransport(
  _config: UpstreamTelemetryTransportConfig = { url: 'wss://team.example.com/bus' },
): BusTransport {
  return {
    name: 'test-upstream',
    send: vi.fn(async () => true) as BusTransport['send'],
    onReceive: () => () => undefined,
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
  };
}

describe('resolveUpstreamTelemetryBootOptionsFromEnv', () => {
  it('returns undefined and does not create a transport when MAKAIO_UPSTREAM_URL is absent', () => {
    const createTransportMock = vi.fn(createTransport);

    const options = resolveUpstreamTelemetryBootOptionsFromEnv({
      env: {},
      createTransport: createTransportMock,
    });

    expect(options).toBeUndefined();
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it('treats a blank MAKAIO_UPSTREAM_URL as disabled', () => {
    const createTransportMock = vi.fn(createTransport);

    const options = resolveUpstreamTelemetryBootOptionsFromEnv({
      env: { MAKAIO_UPSTREAM_URL: '   ' },
      createTransport: createTransportMock,
    });

    expect(options).toBeUndefined();
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it('creates upstream telemetry boot options when MAKAIO_UPSTREAM_URL is set', () => {
    const transport = createTransport();
    const createTransportMock = vi.fn(() => transport);

    const options = resolveUpstreamTelemetryBootOptionsFromEnv({
      env: { MAKAIO_UPSTREAM_URL: 'wss://team.example.com/bus' },
      createTransport: createTransportMock,
    });

    expect(options?.transport).toBe(transport);
    expect(createTransportMock).toHaveBeenCalledWith({ url: 'wss://team.example.com/bus' });
  });

  it('wires the resolved boot options to a real upstream WebSocket transport by default', () => {
    const options = resolveUpstreamTelemetryBootOptionsFromEnv({
      env: { MAKAIO_UPSTREAM_URL: 'wss://team.example.com/bus' },
    });

    expect(options?.transport).toBeInstanceOf(WebSocketClientTransport);
    expect(options?.transport.name).toBe('upstream-telemetry-ws');
  });

  it('trims URL and optional secret before creating the transport', () => {
    // WebSocketClientTransport keeps url/auth private, so the injected factory is
    // the only public surface that exposes the normalized config the resolver
    // produces. Real default-factory wiring is asserted in the test above and in
    // the createUpstreamTelemetryTransport suite.
    const transport = createTransport();
    const createTransportMock = vi.fn(() => transport);

    const options = resolveUpstreamTelemetryBootOptionsFromEnv({
      env: {
        MAKAIO_UPSTREAM_URL: '  wss://team.example.com/bus  ',
        MAKAIO_UPSTREAM_SECRET: '  shared-secret  ',
      },
      createTransport: createTransportMock,
    });

    expect(options?.transport).toBe(transport);
    expect(createTransportMock).toHaveBeenCalledWith({
      url: 'wss://team.example.com/bus',
      secret: 'shared-secret',
    });
  });

  it('creates an unauthenticated transport when MAKAIO_UPSTREAM_SECRET is blank but URL is valid', () => {
    // A blank/whitespace secret is treated as absent (e.g. unprovisioned GitHub
    // Actions secret) and must not suppress transport creation when a URL is set.
    const transport = createTransport();
    const createTransportMock = vi.fn(() => transport);

    const options = resolveUpstreamTelemetryBootOptionsFromEnv({
      env: {
        MAKAIO_UPSTREAM_URL: 'wss://team.example.com/bus',
        MAKAIO_UPSTREAM_SECRET: '   ',
      },
      createTransport: createTransportMock,
    });

    expect(options).toBeDefined();
    expect(options?.transport).toBe(transport);
    // Secret is normalized away — factory receives no secret (unauthenticated).
    expect(createTransportMock).toHaveBeenCalledWith({ url: 'wss://team.example.com/bus' });
  });

  it('rejects MAKAIO_UPSTREAM_SECRET without MAKAIO_UPSTREAM_URL', () => {
    expect(() =>
      resolveUpstreamTelemetryBootOptionsFromEnv({
        env: { MAKAIO_UPSTREAM_SECRET: 'shared-secret' },
        createTransport,
      }),
    ).toThrow('MAKAIO_UPSTREAM_SECRET requires MAKAIO_UPSTREAM_URL');
  });

  it('treats a blank MAKAIO_UPSTREAM_SECRET as absent (e.g. unprovisioned GitHub Actions secret)', () => {
    // An empty or whitespace-only secret must not throw: environments such as
    // GitHub Actions set the variable to "" when the secret is not provisioned,
    // and that should be indistinguishable from "not set".
    const createTransportMock = vi.fn(createTransport);

    const options = resolveUpstreamTelemetryBootOptionsFromEnv({
      env: { MAKAIO_UPSTREAM_SECRET: '   ' },
      createTransport: createTransportMock,
    });

    expect(options).toBeUndefined();
    expect(createTransportMock).not.toHaveBeenCalled();
  });
});

describe('createUpstreamTelemetryTransport', () => {
  it('creates the default WebSocket client transport for upstream telemetry', () => {
    const transport = createUpstreamTelemetryTransport({
      url: 'wss://team.example.com/bus',
      secret: 'shared-secret',
    });

    expect(transport).toBeInstanceOf(WebSocketClientTransport);
    expect(transport.name).toBe('upstream-telemetry-ws');
  });
});
