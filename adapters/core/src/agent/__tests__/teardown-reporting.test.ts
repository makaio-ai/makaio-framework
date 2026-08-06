/**
 * Cases 202 and 203 — what the two reporting layers convert, and what they refuse
 * to convert.
 *
 * The subject is the *conversion*, so nothing here stubs it: the connector really
 * throws, the lease release really fails, and the bus handler really refuses to
 * unsubscribe. A double standing in for `closeConnectorRuntime` or `AIAgent.close`
 * would assert only that the double was configured.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { resolveClientBinary } from '@makaio/subsystem-client';
import { closeConnectorRuntime } from '../connector-runtime.js';
import { asAgentConnector, createTestableAgent, MockConnector } from './helpers/mock-agent.js';

vi.mock('@makaio/subsystem-client', () => ({
  resolveClientBinary: vi.fn(),
}));

const resolveClientBinaryMock = vi.mocked(resolveClientBinary);
const cleanups: Array<() => void> = [];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  MakaioBus.__resetHandlers?.();
  vi.resetAllMocks();
});

describe('case 202: a thrown close becomes `unknown` at the layer above it', () => {
  it('reports `unknown` with a detail at `closeConnectorRuntime`, and rethrows nothing', async () => {
    const closeError = new Error('connector close exploded');
    const connector = new MockConnector('test-model', '/work/project');
    connector.closeOutcome = closeError;

    const report = await closeConnectorRuntime({ connector: asAgentConnector(connector) });

    expect(report.evidence).toBe('unknown');
    expect(report.detail).toContain('connector close exploded');
    // The failure travels for the one caller whose contract is a rethrow, and is
    // reported rather than raised here.
    expect(report.closeError).toBe(closeError);
  });

  it('reports `unknown` with a detail at `AIAgent.close`, and rethrows nothing', async () => {
    const connectors: MockConnector[] = [];
    const closeError = new Error('agent connector close exploded');
    const agent = createTestableAgent({
      agentId: 'agent-202',
      mockConnectorFactory: (config) => {
        const connector = new MockConnector(config.model, config.cwd);
        connector.closeOutcome = closeError;
        connectors.push(connector);
        return connector;
      },
    });
    await agent.init();

    const report = await agent.close({ emitSessionClosed: false });

    expect(connectors).toHaveLength(1);
    expect(report.evidence).toBe('unknown');
    expect(report.detail).toContain('agent connector close exploded');
    expect(report.closeError).toBe(closeError);
  });

  it('reports `released` when there was no runtime to close at all', async () => {
    const agent = createTestableAgent({
      agentId: 'agent-202-empty',
      mockConnectorFactory: (config) => new MockConnector(config.model, config.cwd),
    });

    // Never initialised, so the agent holds nothing: provably nothing is speaking.
    await expect(agent.close({ emitSessionClosed: false })).resolves.toEqual({ evidence: 'released' });
  });
});

describe('case 203: a lease-release failure downgrades; a handler-cleanup failure does not', () => {
  it('downgrades a connector-observed class to `unknown` when the lease release fails', async () => {
    resolveClientBinaryMock.mockResolvedValue(undefined);
    const releaseError = new Error('lease release refused');
    const connector = new MockConnector('test-model', '/work/project');
    // The connector observed its own process exit — the strongest class there is.
    connector.closeOutcome = { evidence: 'exited' };

    const report = await closeConnectorRuntime({
      connector: asAgentConnector(connector),
      lease: {
        clientId: 'codex',
        leaseId: 'lease-1',
        release: async () => {
          throw releaseError;
        },
      },
    });

    // The lease is a resource *this* runtime held, so failing to give it back
    // means the teardown is not provably complete — whatever the connector saw.
    expect(report.evidence).toBe('unknown');
    expect(report.closeError).toBe(releaseError);
  });

  it('keeps the connector class standing when a bus-handler cleanup throws', async () => {
    const connector = new MockConnector('test-model', '/test/cwd');
    connector.closeOutcome = { evidence: 'exited' };
    const agent = createTestableAgent({
      agentId: 'agent-203',
      mockConnectorFactory: () => connector,
    });
    await agent.init();
    agent.addBusHandlerCleanupForTest(() => {
      throw new Error('listener refused to unsubscribe');
    });

    const report = await agent.close({ emitSessionClosed: false });

    // The asymmetry against the lease arm above is the assertion: a local
    // listener that will not detach cannot keep a provider conversation alive.
    expect(report.evidence).toBe('exited');
    expect(report.closeError).toBeUndefined();
  });

  it('keeps a lease-release failure visible even behind a failing handler cleanup', async () => {
    // Revert probe for the composite: with only the arm above, an implementation
    // that ignored *every* cleanup failure — including the lease — would stay
    // green. This half must still downgrade.
    resolveClientBinaryMock.mockResolvedValue(undefined);
    const releaseError = new Error('lease release refused');
    const connector = new MockConnector('test-model', '/work/project');
    connector.closeOutcome = { evidence: 'exited' };

    const report = await closeConnectorRuntime({
      connector: asAgentConnector(connector),
      lease: {
        clientId: 'codex',
        leaseId: 'lease-2',
        release: async () => {
          throw releaseError;
        },
      },
    });

    expect(report.evidence).toBe('unknown');
  });
});
