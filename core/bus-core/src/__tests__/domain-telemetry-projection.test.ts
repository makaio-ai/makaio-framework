import { describe, expect, it } from 'vitest';
import { AgentNamespace } from '@makaio/contracts';
import { ClientNamespace } from '@makaio/contracts/client';
import { WorkflowNamespace } from '@makaio/contracts/workflow';
import { createBusInstance } from '../bus.js';
import { projectSubjectTelemetryFacts } from '../observability/index.js';

describe('domain subject telemetry projection', () => {
  it('projects rich agent usage dimensions without nested quota data', () => {
    const bus = createBusInstance();
    bus.registerNamespace(AgentNamespace);

    const [fact] = projectSubjectTelemetryFacts({
      message: {
        type: 'event',
        namespace: 'agent',
        subject: 'usage',
        messageId: 'usage-1',
        payload: {
          agentId: 'review-agent',
          adapterId: 'adapter-instance-1',
          adapterName: 'claude-code',
          sessionId: 'session-1',
          adapterSessionId: 'native-session-1',
          messageId: 'message-1',
          turnId: 'turn-1',
          clientId: 'claude-code',
          providerConfigId: 'anthropic-oauth',
          llmCallId: 'call-1',
          executionId: 'execution-1',
          frameId: 'frame-1',
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          inputTokens: 100,
          inputCachedTokens: 80,
          cacheWriteTokens: 10,
          outputTokens: 20,
          reasoningTokens: 2,
          totalTokens: 122,
          costUnits: 122,
          costUnitType: 'tokens',
          cost: 0.15,
          currency: 'USD',
          costProvenance: 'estimated',
          duration: 450,
          quota: { type: 'weekly', limit: 100, used: 10, overage: 0 },
        },
      },
      direction: 'outbound',
      observedAt: 2000,
      namespaceRegistry: bus.getContext().namespaceRegistry,
    });

    expect(fact.attributes).toMatchObject({
      'makaio.agent.id': 'review-agent',
      'makaio.adapter.id': 'adapter-instance-1',
      'makaio.adapter.name': 'claude-code',
      'makaio.session.id': 'session-1',
      'makaio.adapter.session_id': 'native-session-1',
      'makaio.message.id': 'message-1',
      'makaio.turn.id': 'turn-1',
      'makaio.client.id': 'claude-code',
      'makaio.provider.config_id': 'anthropic-oauth',
      'makaio.llm_call.id': 'call-1',
      'makaio.execution.id': 'execution-1',
      'makaio.frame.id': 'frame-1',
      'llm.provider': 'anthropic',
      'llm.model': 'claude-opus-4-6',
      'llm.tokens.input': 100,
      'llm.tokens.cached_input': 80,
      'llm.tokens.cache_write': 10,
      'llm.tokens.output': 20,
      'llm.tokens.total': 122,
      'llm.cost.units': 122,
      'llm.cost.unit_type': 'tokens',
      'llm.cost.amount': 0.15,
      'llm.cost.currency': 'USD',
      'llm.cost.provenance': 'estimated',
      'llm.duration_ms': 450,
    });
    expect(Object.keys(fact.attributes).some((key) => key.startsWith('quota'))).toBe(false);
  });

  it('projects exact workflow frame/session correlation identifiers', () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);

    const [fact] = projectSubjectTelemetryFacts({
      message: {
        type: 'event',
        namespace: 'workflow',
        subject: 'frame.sessionLinked',
        messageId: 'link-1',
        payload: { executionId: 'execution-1', frameId: 'frame-1', sessionId: 'session-1' },
      },
      direction: 'outbound',
      observedAt: 2000,
      namespaceRegistry: bus.getContext().namespaceRegistry,
    });

    expect(fact.attributes).toEqual({
      'makaio.execution.id': 'execution-1',
      'makaio.frame.id': 'frame-1',
      'makaio.session.id': 'session-1',
    });
  });

  it('projects client lifecycle identifiers without prompt, transcript, or metadata content', () => {
    const bus = createBusInstance();
    bus.registerNamespace(ClientNamespace);

    const [fact] = projectSubjectTelemetryFacts({
      message: {
        type: 'event',
        namespace: 'client',
        subject: 'session.userPrompt.submitted',
        messageId: 'prompt-1',
        payload: {
          clientId: 'claude-code',
          source: 'native-hook',
          observedAt: 2000,
          sessionId: 'session-1',
          adapterSessionId: 'native-session-1',
          prompt: 'private prompt',
          metadata: { transcriptPath: '/private/transcript.jsonl' },
        },
      },
      direction: 'outbound',
      observedAt: 2001,
      namespaceRegistry: bus.getContext().namespaceRegistry,
    });

    expect(fact.attributes).toEqual({
      'makaio.client.id': 'claude-code',
      'makaio.client.lifecycle.source': 'native-hook',
      'event.observed_at': 2000,
      'makaio.session.id': 'session-1',
      'makaio.adapter.session_id': 'native-session-1',
    });
    expect(JSON.stringify(fact.attributes)).not.toContain('private');
  });

  it('projects rich session usage separately from account quota windows', () => {
    const bus = createBusInstance();
    bus.registerNamespace(ClientNamespace);

    const [fact] = projectSubjectTelemetryFacts({
      message: {
        type: 'event',
        namespace: 'client',
        subject: 'session.usage.snapshot',
        messageId: 'snapshot-1',
        payload: {
          clientId: 'claude-code',
          clientAccountId: 'account-1',
          adapterSessionId: 'native-session-1',
          source: 'statusline',
          observedAt: 2000,
          modelId: 'claude-opus-4-6',
          latestRequestInputTokens: 100,
          currentContextInputTokens: 80_000,
          totalCost: 12.68,
          costCurrency: 'USD',
          costProvenance: 'client-reported',
        },
      },
      direction: 'outbound',
      observedAt: 2001,
      namespaceRegistry: bus.getContext().namespaceRegistry,
    });

    expect(fact.attributes).toMatchObject({
      'makaio.client.account_id': 'account-1',
      'llm.model': 'claude-opus-4-6',
      'llm.tokens.latest_request.input': 100,
      'llm.context.tokens.input': 80_000,
      'llm.cost.total': 12.68,
      'llm.cost.provenance': 'client-reported',
    });
  });
});
