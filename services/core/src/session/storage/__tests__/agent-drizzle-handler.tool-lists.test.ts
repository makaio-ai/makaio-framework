import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { MakaioBus } from '@makaio/bus-core';
import { AgentStorageSubjects } from '../agent-namespace.js';
import { createAgent, useDrizzleTestLifecycle } from './shared.js';

describe('registerDrizzleAgentStorage.allowedTools/disallowedTools', () => {
  const ctx = useDrizzleTestLifecycle();

  beforeEach(async () => {
    await ctx.exec(sql`
      INSERT INTO sessions (session_id, created_at, last_activity_at, status)
      VALUES ('session-1', ${Date.now()}, ${Date.now()}, 'active')
    `);
  });

  it('round-trips allowedTools and disallowedTools', async () => {
    const agent = createAgent({
      sessionId: 'session-1',
      agentId: 'agent-tools',
      allowedTools: ['read_file', 'edit_file'],
      disallowedTools: ['shell_exec'],
    });

    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId: agent.agentId,
      agent,
    });

    const result = await MakaioBus.request(AgentStorageSubjects.get, {
      agentId: 'agent-tools',
    });

    expect(result.agent?.allowedTools).toEqual(['read_file', 'edit_file']);
    expect(result.agent?.disallowedTools).toEqual(['shell_exec']);
  });

  it('preserves an empty tool list rather than collapsing it to undefined', async () => {
    const agent = createAgent({
      sessionId: 'session-1',
      agentId: 'agent-empty-tools',
      allowedTools: [],
      disallowedTools: [],
    });

    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId: agent.agentId,
      agent,
    });

    const result = await MakaioBus.request(AgentStorageSubjects.get, {
      agentId: 'agent-empty-tools',
    });

    expect(result.agent?.allowedTools).toEqual([]);
    expect(result.agent?.disallowedTools).toEqual([]);
  });

  it('maps absent allowedTools/disallowedTools to undefined', async () => {
    const agent = createAgent({
      sessionId: 'session-1',
      agentId: 'agent-no-tools',
      allowedTools: undefined,
      disallowedTools: undefined,
    });

    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId: agent.agentId,
      agent,
    });

    const result = await MakaioBus.request(AgentStorageSubjects.get, {
      agentId: 'agent-no-tools',
    });

    expect(result.agent?.allowedTools).toBeUndefined();
    expect(result.agent?.disallowedTools).toBeUndefined();
  });
});
