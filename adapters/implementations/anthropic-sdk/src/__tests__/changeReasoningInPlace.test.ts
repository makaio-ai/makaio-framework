import os from 'node:os';
import { describeChangeReasoningInPlaceContract } from '@makaio/ai-adapters-stream-session/testing';
import { AnthropicSdkConnector } from '../connector.js';
import { AnthropicSdkConnectorNamespace } from '../namespaces/index.js';

describeChangeReasoningInPlaceContract('AnthropicSdkConnector', async () => {
  const bus = await AnthropicSdkConnectorNamespace.scopedBus();
  return new AnthropicSdkConnector({
    bus,
    adapterId: 'adapter-test',
    adapterName: 'anthropic-sdk',
    agentId: 'agent-test',
    model: 'claude-sonnet-4-20250514',
    cwd: os.tmpdir(),
    env: {},
    providerConfig: {},
  });
});
