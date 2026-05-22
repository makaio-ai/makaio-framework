import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';
import { PreferencesSubjects } from '../../../preferences/storage-namespace.js';
import { routeToAgents } from '../route-to-agents.js';
import { Turn } from '../../entities/turn.js';
import { createRouteTestContext, ROUTE_TEST_IDS, type RouteTestContext } from './shared.js';
import { createTestAgent, createTestSession } from '../../__tests__/shared.js';

/**
 * Extract cwdChange.message from SessionContext without assuming a strict shape.
 * Session injected context intentionally remains extensible and partially typed.
 * @param sessionContext - Session context delivered to the adapter
 * @returns CWD change notification message when present
 */
function getCwdChangeMessage(sessionContext: unknown): string | undefined {
  if (typeof sessionContext !== 'object' || sessionContext === null) {
    return undefined;
  }
  const contextRecord = sessionContext as Record<string, unknown>;
  const turnContext = contextRecord.turnContext;
  if (typeof turnContext !== 'object' || turnContext === null) {
    return undefined;
  }
  const turnContextRecord = turnContext as Record<string, unknown>;
  const candidate = turnContextRecord.cwdChange;
  if (typeof candidate !== 'object' || candidate === null) {
    return undefined;
  }
  const record = candidate as Record<string, unknown>;
  return typeof record.message === 'string' ? record.message : undefined;
}

describe('routeToAgents - cwd change notification preferences', () => {
  const { sessionId, messageId, turnId, testMessage } = ROUTE_TEST_IDS;
  let ctx: RouteTestContext;

  beforeEach(() => {
    ctx = createRouteTestContext();
  });

  afterEach(() => {
    ctx.destroy();
  });

  /**
   * Shorthand for ctx.trackUnsubscribe.
   * @param unsub - Unsubscribe function to track
   */
  const trackUnsubscribe = (unsub: () => void) => ctx.trackUnsubscribe(unsub);

  it('applies custom template with repeated placeholders', async () => {
    const agent = createTestAgent('agent-1');
    const session = createTestSession(sessionId, { agents: [agent] });
    const turn = new Turn({ sessionId, agentIds: [agent.agentId], turnId, turnNumber: 1 });
    const swappedAgentIds = new Set(['agent-1']);
    const swappedAgentCwd = new Map([['agent-1', { previousCwd: '/old', newCwd: '/new' }]]);
    let cwdChangeMessage: string | undefined;

    trackUnsubscribe(
      MakaioBus.on(PreferencesSubjects.get, (context) => {
        context.setResult({
          value: {
            enabled: true,
            template: '{oldCwd} -> {newCwd}; again {oldCwd} -> {newCwd}',
          },
        });
      }),
    );

    trackUnsubscribe(
      MakaioBus.on(AgentSubjects.sendMessage, (context) => {
        cwdChangeMessage = getCwdChangeMessage(context.payload.sessionContext);
        context.setResult({ messageId: context.payload.messageId ?? 'generated-id' });
      }),
    );

    await routeToAgents(
      MakaioBus,
      session,
      [agent],
      testMessage,
      messageId,
      turn,
      undefined,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      swappedAgentIds,
      swappedAgentCwd,
      [],
    );

    expect(cwdChangeMessage).toBe('/old -> /new; again /old -> /new');
  });

  it('omits cwdChange when notification preference is disabled', async () => {
    const agent = createTestAgent('agent-1');
    const session = createTestSession(sessionId, { agents: [agent] });
    const turn = new Turn({ sessionId, agentIds: [agent.agentId], turnId, turnNumber: 1 });
    const swappedAgentIds = new Set(['agent-1']);
    const swappedAgentCwd = new Map([['agent-1', { previousCwd: '/old', newCwd: '/new' }]]);
    let hasCwdChange = false;

    trackUnsubscribe(
      MakaioBus.on(PreferencesSubjects.get, (context) => {
        context.setResult({
          value: {
            enabled: false,
            template: 'ignored',
          },
        });
      }),
    );

    trackUnsubscribe(
      MakaioBus.on(AgentSubjects.sendMessage, (context) => {
        hasCwdChange = context.payload.sessionContext?.turnContext?.cwdChange !== undefined;
        context.setResult({ messageId: context.payload.messageId ?? 'generated-id' });
      }),
    );

    await routeToAgents(
      MakaioBus,
      session,
      [agent],
      testMessage,
      messageId,
      turn,
      undefined,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      swappedAgentIds,
      swappedAgentCwd,
      [],
    );

    expect(hasCwdChange).toBe(false);
  });

  it('falls back to default notification when preference lookup fails', async () => {
    const agent = createTestAgent('agent-1');
    const session = createTestSession(sessionId, { agents: [agent] });
    const turn = new Turn({ sessionId, agentIds: [agent.agentId], turnId, turnNumber: 1 });
    const swappedAgentIds = new Set(['agent-1']);
    const swappedAgentCwd = new Map([['agent-1', { previousCwd: '/old', newCwd: '/new' }]]);
    let cwdChangeMessage: string | undefined;

    trackUnsubscribe(
      MakaioBus.on(PreferencesSubjects.get, () => {
        throw new Error('preferences unavailable');
      }),
    );

    trackUnsubscribe(
      MakaioBus.on(AgentSubjects.sendMessage, (context) => {
        cwdChangeMessage = getCwdChangeMessage(context.payload.sessionContext);
        context.setResult({ messageId: context.payload.messageId ?? 'generated-id' });
      }),
    );

    await routeToAgents(
      MakaioBus,
      session,
      [agent],
      testMessage,
      messageId,
      turn,
      undefined,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      swappedAgentIds,
      swappedAgentCwd,
      [],
    );

    expect(cwdChangeMessage).toBe('User changed working directory from /old to /new');
  });

  it('falls back to default notification when stored preference has invalid shape', async () => {
    const agent = createTestAgent('agent-1');
    const session = createTestSession(sessionId, { agents: [agent] });
    const turn = new Turn({ sessionId, agentIds: [agent.agentId], turnId, turnNumber: 1 });
    const swappedAgentIds = new Set(['agent-1']);
    const swappedAgentCwd = new Map([['agent-1', { previousCwd: '/old', newCwd: '/new' }]]);
    let cwdChangeMessage: string | undefined;

    trackUnsubscribe(
      MakaioBus.on(PreferencesSubjects.get, (context) => {
        context.setResult({
          value: {
            enabled: 'true',
            template: 42,
          },
        });
      }),
    );

    trackUnsubscribe(
      MakaioBus.on(AgentSubjects.sendMessage, (context) => {
        cwdChangeMessage = getCwdChangeMessage(context.payload.sessionContext);
        context.setResult({ messageId: context.payload.messageId ?? 'generated-id' });
      }),
    );

    await routeToAgents(
      MakaioBus,
      session,
      [agent],
      testMessage,
      messageId,
      turn,
      undefined,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      swappedAgentIds,
      swappedAgentCwd,
      [],
    );

    expect(cwdChangeMessage).toBe('User changed working directory from /old to /new');
  });

  it('falls back to default notification when preference is missing', async () => {
    const agent = createTestAgent('agent-1');
    const session = createTestSession(sessionId, { agents: [agent] });
    const turn = new Turn({ sessionId, agentIds: [agent.agentId], turnId, turnNumber: 1 });
    const swappedAgentIds = new Set(['agent-1']);
    const swappedAgentCwd = new Map([['agent-1', { previousCwd: '/old', newCwd: '/new' }]]);
    let cwdChangeMessage: string | undefined;

    trackUnsubscribe(
      MakaioBus.on(PreferencesSubjects.get, (context) => {
        context.setResult({ value: null });
      }),
    );

    trackUnsubscribe(
      MakaioBus.on(AgentSubjects.sendMessage, (context) => {
        cwdChangeMessage = getCwdChangeMessage(context.payload.sessionContext);
        context.setResult({ messageId: context.payload.messageId ?? 'generated-id' });
      }),
    );

    await routeToAgents(
      MakaioBus,
      session,
      [agent],
      testMessage,
      messageId,
      turn,
      undefined,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      swappedAgentIds,
      swappedAgentCwd,
      [],
    );

    expect(cwdChangeMessage).toBe('User changed working directory from /old to /new');
  });
});
