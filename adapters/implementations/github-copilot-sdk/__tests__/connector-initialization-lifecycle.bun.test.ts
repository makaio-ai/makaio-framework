/// <reference types="bun-types" />
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { waitFor } from '@makaio/test-utils';

interface Deferred<T> {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
}

interface InitCall {
  assertCurrent: () => void;
  callbacks: {
    onProvisionalResources?: (client: unknown, session: unknown) => void;
  };
}

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
};

const initHarness = {
  calls: [] as InitCall[],
  createDeferred,
  deferred: undefined as Deferred<unknown> | undefined,
};

mock.module('../src/session-init.js', () => ({
  performSessionInit: mock((_ctx: unknown, callbacks: InitCall['callbacks'], assertCurrent: () => void) => {
    initHarness.calls.push({ callbacks, assertCurrent });
    return initHarness.deferred?.promise ?? Promise.reject(new Error('performSessionInit deferred was not set'));
  }),
}));

import { GitHubCopilotConnector } from '../src/connector.js';
import { GitHubCopilotConnectorNamespace } from '../src/namespaces/index.js';

interface MockClient {
  stop: ReturnType<typeof mock>;
}

interface MockSession {
  abort: ReturnType<typeof mock>;
  destroy: ReturnType<typeof mock>;
  processQueue: ReturnType<typeof mock>;
}

function makeInitResult(): { adapterSessionId: string; client: MockClient; session: MockSession } {
  return {
    adapterSessionId: 'adapter-session-test',
    client: {
      stop: mock().mockResolvedValue(undefined),
    },
    session: {
      abort: mock().mockResolvedValue(undefined),
      destroy: mock().mockResolvedValue(undefined),
      processQueue: mock().mockResolvedValue(undefined),
    },
  };
}

class ObservableWireConnector extends GitHubCopilotConnector {
  public sessionSeenDuringWire: unknown;

  protected override wireSessionEvents(): void {
    this.sessionSeenDuringWire = Reflect.get(this, 'session');
  }
}

async function makeConnector(): Promise<ObservableWireConnector> {
  const bus = await GitHubCopilotConnectorNamespace.scopedBus();
  return new ObservableWireConnector({
    bus,
    adapterId: 'adapter-test',
    adapterName: 'github-copilot-sdk',
    agentId: 'agent-test',
    model: 'gpt-4o-mini',
    cwd: process.cwd(),
    env: {},
  });
}

describe('github-copilot-sdk connector initialization lifecycle', () => {
  beforeEach(() => {
    initHarness.calls.length = 0;
    initHarness.deferred = initHarness.createDeferred();
  });

  it('wires turn events after publishing the initialized session', async () => {
    const connector = await makeConnector();
    const initResult = makeInitResult();

    const initializePromise = connector.initialize();
    await waitFor(() => expect(initHarness.calls).toHaveLength(1));

    initHarness.deferred?.resolve(initResult);
    await initializePromise;

    expect(connector.sessionSeenDuringWire).toBe(initResult.session);
    await connector.close();
  });

  it('closes initialized resources when close wins the final publication race', async () => {
    const connector = await makeConnector();
    const initResult = makeInitResult();

    const initializePromise = connector.initialize();
    await waitFor(() => expect(initHarness.calls).toHaveLength(1));

    initHarness.deferred?.resolve(initResult);
    await connector.close();

    await expect(initializePromise).rejects.toThrow('GitHub Copilot session initialization was cancelled');
    expect(initResult.session.abort).toHaveBeenCalledTimes(1);
    expect(initResult.session.destroy).toHaveBeenCalledTimes(1);
    expect(initResult.client.stop).toHaveBeenCalledTimes(1);
  });
});
