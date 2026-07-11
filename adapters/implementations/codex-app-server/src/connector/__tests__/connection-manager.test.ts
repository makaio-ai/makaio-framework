import { describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { ConnectionManagerContext } from '../connection-manager.js';
import { CodexConnectionResetError, resetClient } from '../connection-manager.js';
import type { JsonRpcClient } from '../../utils/jsonRpcClient.js';
import type { StdioTransport } from '../../utils/createStdioTransport.js';
import { MockJsonRpcClient } from '../../__tests__/shared.js';

/**
 * Build mutable connection state around injectable cleanup operations.
 * @param closeClient - Client close behavior injected by the test
 * @param closeTransport - Transport close behavior injected by the test
 * @returns Mutable connection-manager harness and observable state reader
 */
function createResetHarness(
  closeClient: () => void,
  closeTransport: () => void,
): {
  readonly context: ConnectionManagerContext;
  readonly state: () => {
    readonly client: JsonRpcClient | undefined;
    readonly ownedTransport: StdioTransport | undefined;
    readonly connected: boolean;
    readonly handlersRegistered: boolean;
    readonly disabledNativeTools: ReadonlySet<string>;
  };
} {
  const mockClient = new MockJsonRpcClient();
  mockClient.close = closeClient;
  let client: JsonRpcClient | undefined = mockClient;
  let ownedTransport: StdioTransport | undefined = {
    send: () => undefined,
    close: closeTransport,
    onMessage: () => undefined,
    onError: () => undefined,
  };
  let connected = true;
  let handlersRegistered = true;
  let disabledNativeTools: ReadonlySet<string> = new Set(['bash']);

  return {
    context: {
      getJsonRpcClient: () => client,
      setJsonRpcClient: (value) => {
        client = value;
      },
      getInjectedJsonRpcClient: () => undefined,
      getInjectedTransport: () => undefined,
      getOwnedTransport: () => ownedTransport,
      setOwnedTransport: (value) => {
        ownedTransport = value;
      },
      getIsConnected: () => connected,
      setIsConnected: (value) => {
        connected = value;
      },
      setClientHandlersRegistered: (value) => {
        handlersRegistered = value;
      },
      setDisabledNativeTools: (value) => {
        disabledNativeTools = value;
      },
      cwd: '/tmp',
      env: {},
      adapterName: 'codex-app-server',
      clientId: 'codex',
      clientExecution: undefined,
      getAccountLogin: () => undefined,
      harnessId: undefined,
      globalBus: MakaioBus,
      registerClientHandlers: () => undefined,
      handleError: () => undefined,
    },
    state: () => ({ client, ownedTransport, connected, handlersRegistered, disabledNativeTools }),
  };
}

describe('Codex connection manager cleanup', () => {
  it('resets and closes an owned process client after a failed ready handshake', () => {
    const closeClient = vi.fn();
    const closeTransport = vi.fn();
    const harness = createResetHarness(closeClient, closeTransport);

    resetClient(harness.context);
    const state = harness.state();

    expect(state.connected).toBe(false);
    expect(state.handlersRegistered).toBe(false);
    expect(state.disabledNativeTools.size).toBe(0);
    expect(closeClient).toHaveBeenCalledOnce();
    expect(closeTransport).not.toHaveBeenCalled();
    expect(state.ownedTransport).toBeUndefined();
    expect(state.client).toBeUndefined();
  });

  it('attempts transport fallback, clears retry state, and sanitizes simultaneous reset failures', () => {
    const closeClient = vi.fn(() => {
      throw new Error('client close echoed private-api-key');
    });
    const closeTransport = vi.fn(() => {
      throw new Error('transport close echoed private-api-key');
    });
    const harness = createResetHarness(closeClient, closeTransport);

    let resetError: unknown;
    try {
      resetClient(harness.context);
    } catch (error) {
      resetError = error;
    }
    const state = harness.state();

    expect(resetError).toBeInstanceOf(AggregateError);
    expect((resetError as AggregateError).errors).toEqual([
      expect.objectContaining<Partial<CodexConnectionResetError>>({ reason: 'client-close-failed' }),
      expect.objectContaining<Partial<CodexConnectionResetError>>({ reason: 'transport-close-failed' }),
    ]);
    expect((resetError as Error).message).not.toContain('private-api-key');
    expect(closeClient).toHaveBeenCalledOnce();
    expect(closeTransport).toHaveBeenCalledOnce();
    expect(state.ownedTransport).toBeUndefined();
    expect(state.client).toBeUndefined();
  });
});
