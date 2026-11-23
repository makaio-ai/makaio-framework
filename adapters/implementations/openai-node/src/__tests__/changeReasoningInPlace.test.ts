import os from 'node:os';
import { describeChangeReasoningInPlaceContract } from '@makaio/ai-adapters-stream-session/testing';
import { createTestBusInstance } from '@makaio/test-utils';
import { OpenAINodeConnector } from '../connector.js';
import { OpenAINodeConnectorNamespace } from '../namespaces/index.js';

describeChangeReasoningInPlaceContract('OpenAINodeConnector', async () => {
  const globalBus = createTestBusInstance();
  globalBus.registerNamespaces([OpenAINodeConnectorNamespace.definition]);
  const bus = await OpenAINodeConnectorNamespace.scopedBus(globalBus);
  return new OpenAINodeConnector({
    bus,
    globalBus,
    adapterId: 'adapter-test',
    adapterName: 'openai-node',
    agentId: 'agent-test',
    model: 'gpt-4o',
    cwd: os.tmpdir(),
    env: {},
    providerConfig: {},
  });
});
