import { describe, expect, it } from 'bun:test';
import { createTestableAgent, MockConnector } from './helpers/mock-agent.js';

/**
 * Create the shared mock connector factory for AIAgent tests.
 * @returns Factory that creates MockConnector instances from model/cwd config
 */
function makeMockConnectorFactory(): (config: { model: string; cwd: string }) => MockConnector {
  return (config) => new MockConnector(config.model, config.cwd);
}

/**
 * Build shared options for createTestableAgent in systemPrompt tests.
 * @param agentId - Unique agent identifier for the test case
 * @param initialModel - Initial model name
 * @param initialCwd - Initial working directory
 * @returns Options object for createTestableAgent
 */
function makeTestableAgentOptions(agentId: string, initialModel: string, initialCwd: string) {
  return {
    agentId,
    mockConnectorFactory: makeMockConnectorFactory(),
    initialModel,
    initialCwd,
  };
}

describe('AIAgent systemPrompt capture', () => {
  it('captures empty-string systemPrompt during initialize', async () => {
    const agent = createTestableAgent(
      makeTestableAgentOptions('test-agent-system-prompt-init', 'test-model', '/test/cwd'),
    );

    try {
      await agent.initialize({ systemPrompt: '' });
      expect(Reflect.get(agent, 'runtimeSystemPrompt')).toBe('');
    } finally {
      await agent.close();
    }
  });

  it('captures empty-string systemPrompt during start before connector dispatch', async () => {
    const agent = createTestableAgent(
      makeTestableAgentOptions('test-agent-system-prompt-start', 'test-model', '/test/cwd'),
    );

    try {
      await agent.start('hello', { systemPrompt: '' }).catch(() => {});
      expect(Reflect.get(agent, 'runtimeSystemPrompt')).toBe('');
    } finally {
      await agent.close();
    }
  });
});
