import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { AuthCredentialRefSchema } from '@makaio/contracts';
import { PiConnector } from '../connector.js';
import { PiSdkNamespace } from '../namespaces/index.js';
import type { PiToolHandlerContext } from '../tool-conversion.js';

describe('PiConnector context environment', () => {
  it('keeps connector authentication out of tool execution contexts', async () => {
    const connector = new PiConnector({
      bus: await PiSdkNamespace.scopedBus(),
      adapterId: 'adapter-pi-context',
      adapterName: 'pi-sdk',
      agentId: 'agent-pi-context',
      model: 'claude-sonnet-4-20250514',
      cwd: os.tmpdir(),
      env: { ANTHROPIC_API_KEY: 'selected-process-secret' },
      contextEnv: { PATH: '/usr/bin', CONFIG_HOME: '/isolated/pi' },
      adapterAuth: {
        processEnv: {},
        connectorDeliveries: [
          {
            target: 'pi-sdk.provider-auth',
            values: { apiKey: 'selected-connector-secret' },
          },
        ],
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

    const context = Reflect.get(connector, 'toolContext') as PiToolHandlerContext;

    expect(context.env).toEqual({ PATH: '/usr/bin', CONFIG_HOME: '/isolated/pi' });
    expect(JSON.stringify(context.env)).not.toContain('secret');
  });
});
