import os from 'node:os';
import { describeChangeReasoningInPlaceContract } from '@makaio/ai-adapters-stream-session/testing';
import { OpenAINodeConnector } from '../connector.js';
import { OpenAINodeConnectorNamespace } from '../namespaces/index.js';

describeChangeReasoningInPlaceContract('OpenAINodeConnector', async () => {
  const bus = await OpenAINodeConnectorNamespace.scopedBus();
  return new OpenAINodeConnector({
    bus,
    adapterId: 'adapter-test',
    adapterName: 'openai-node',
    agentId: 'agent-test',
    model: 'gpt-4o',
    cwd: os.tmpdir(),
    env: {},
    providerConfig: {},
  });
});
