import os from 'node:os';
import { createTestBusInstance } from '@makaio/test-utils';
import { describe, expect, it } from 'vitest';
import { AuthCredentialRefSchema } from '@makaio/contracts';
import { PiConnector } from '../connector.js';
import { PiSdkNamespace, PiSdkSubjects } from '../namespaces/index.js';
import type { PiToolHandlerContext } from '../tool-conversion.js';

/** Pi connector with the shared turn-wiring seam exposed for lifecycle tests. */
class TestPiConnector extends PiConnector {
  /** Install the production turn handlers without creating a Pi SDK session. */
  public wireTurnEvents(): void {
    this.wireSessionEvents();
  }
}

/**
 * Create a Pi connector with an isolated host bus.
 * @param hostBus - Bus instance that owns the connector namespace
 * @returns Configured connector and its scoped bus
 */
async function createConnector(hostBus = createTestBusInstance()) {
  const bus = await PiSdkNamespace.scopedBus(hostBus.getContext());
  const connector = new TestPiConnector({
    bus,
    globalBus: hostBus,
    adapterId: 'adapter-pi-context',
    adapterName: 'pi-sdk',
    agentId: 'agent-pi-context',
    model: 'claude-sonnet-4-20250514',
    cwd: os.tmpdir(),
    env: { ANTHROPIC_API_KEY: 'selected-process-secret' },
    contextEnv: { PATH: '/usr/bin', CONFIG_HOME: '/isolated/pi' },
    adapterAuth: {
      processEnv: {},
      connectorDeliveries: [{ target: 'pi-sdk.provider-auth', values: { apiKey: 'selected-connector-secret' } }],
      configInheritance: 'empty',
    },
    providerContext: {
      state: 'resolved',
      providerConfigId: 'provider-config-pi-context',
      definitionId: 'anthropic',
      auth: {
        mode: 'explicit',
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
        definition: {
          id: 'api-key',
          mode: 'explicit',
          label: 'API key',
          fields: [
            {
              id: 'apiKey',
              label: 'API key',
              required: true,
              secret: true,
              sourceHints: [{ kind: 'environment', variable: 'ANTHROPIC_API_KEY' }],
            },
          ],
        },
        credentialRefs: { apiKey: AuthCredentialRefSchema.parse('env:ANTHROPIC_API_KEY') },
      },
    },
    providerProtocol: 'anthropic',
    providerConfig: {},
  });
  return { bus, connector };
}

describe('PiConnector context environment', () => {
  it('keeps connector authentication out of tool execution contexts', async () => {
    const { connector } = await createConnector();

    const context = Reflect.get(connector, 'toolContext') as PiToolHandlerContext;

    expect(context.env).toEqual({ PATH: '/usr/bin', CONFIG_HOME: '/isolated/pi' });
    expect(JSON.stringify(context.env)).not.toContain('secret');
  });

  it('removes its turn handlers before reporting a released close', async () => {
    const { bus, connector } = await createConnector();
    connector.wireTurnEvents();

    await expect(connector.close()).resolves.toEqual({ evidence: 'released' });
    await bus.emit(PiSdkSubjects.turn.turn_started, {
      adapterId: 'adapter-pi-context',
      agentId: 'agent-pi-context',
      oldState: 'idle',
      newState: 'turn_started',
      timestamp: Date.now(),
    });

    expect(connector.getProcessingState()).toBe('idle');
  });
});
