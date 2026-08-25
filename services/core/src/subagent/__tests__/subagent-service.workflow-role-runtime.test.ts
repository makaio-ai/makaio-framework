import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects, SubagentSubjects, type ResolvedProviderContext } from '@makaio/contracts';
import { SessionStorageSubjects } from '../../session/storage/namespace.js';
import { SubagentService } from '../subagent-service.js';
import { setupSubagentServiceMocks, type SubagentServiceMockController } from './subagent-service.mocks.js';

describe('SubagentService workflow role runtime config', () => {
  let service: SubagentService;
  let mocks: SubagentServiceMockController;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    mocks = setupSubagentServiceMocks(MakaioBus);
    service = new SubagentService(MakaioBus);
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
    MakaioBus.__resetHandlers?.();
  });

  it('preserves resolved-role governance and inherits the parent working directory', async () => {
    const providerContext = {
      state: 'resolved',
      providerConfigId: 'provider-config-role',
      definitionId: 'provider-definition-role',
      auth: {
        mode: 'none',
        method: { owner: 'provider', providerDefinitionId: 'provider-definition-role', methodId: 'none' },
        definition: { id: 'none', mode: 'none', label: 'No authentication' },
      },
    } satisfies ResolvedProviderContext;
    const sessionCreates: unknown[] = [];
    const adapterStarts: unknown[] = [];

    MakaioBus.on(
      SessionStorageSubjects.get,
      (ctx) => {
        ctx.setResult({
          session: {
            sessionId: ctx.payload.sessionId,
            createdAt: 0,
            lastActivityAt: 0,
            status: 'active',
            agents: [],
            targetWorkingDirectory: '/workspace/parent',
          },
        });
      },
      { priority: 100 },
    );
    MakaioBus.on(SessionSubjects.create, (ctx) => {
      sessionCreates.push(ctx.payload);
      ctx.setResult({ sessionId: 'child-role-runtime' });
    });
    mocks.setStartAgentHandler((ctx) => {
      adapterStarts.push(ctx.payload);
      ctx.setResult({
        success: true,
        agentId: 'agent-role-runtime',
        adapterId: String(ctx.payload.adapterId),
        ownerInstanceId: 'test-owner-instance',
        adapterSessionId: 'adapter-session-role-runtime',
        sessionId: 'child-role-runtime',
      });
    });

    const result = await MakaioBus.request(SubagentSubjects.execute, {
      subagentId: 'subagent-role-runtime',
      parentSessionId: 'parent-role-runtime',
      task: 'Execute the resolved role',
      config: {
        task: 'Execute the resolved role',
        adapterName: 'claude-code',
        providerConfigId: 'provider-config-role',
        providerContext,
        adapterConfig: {},
        tools: [],
        disallowedTools: [],
        allowedDirectories: [],
        contextMode: 'fork',
      },
      depth: 1,
    });

    expect(result).toEqual({ success: true });
    expect(sessionCreates).toEqual([
      expect.objectContaining({
        parentSessionId: 'parent-role-runtime',
        targetWorkingDirectory: '/workspace/parent',
      }),
    ]);
    expect(adapterStarts).toEqual([
      expect.objectContaining({
        sessionId: 'child-role-runtime',
        providerContext,
        adapterConfig: {},
        cwd: '/workspace/parent',
        allowedTools: [],
        disallowedTools: [],
        allowedDirectories: [],
      }),
    ]);
  });
});
