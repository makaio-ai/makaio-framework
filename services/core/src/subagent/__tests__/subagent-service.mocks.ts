import { AdapterSubjects } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '@makaio/services-core/adapter-runtime';
import { ExecutionTargetSubjects } from '../../execution-target/namespace.js';
import { SessionStorageSubjects } from '../../session/storage/namespace.js';
import type { ExtractSubjectPayload, ExtractSubjectResponse } from '@makaio/core';

type StartAgentPayload = ExtractSubjectPayload<typeof AdapterSubjects.startAgent>;
type StartAgentResponse = ExtractSubjectResponse<typeof AdapterSubjects.startAgent>;

type StartAgentHandler = (ctx: { payload: StartAgentPayload; setResult: (result: StartAgentResponse) => void }) => void;

export interface SubagentServiceMockController {
  setStartAgentHandler: (handler: StartAgentHandler) => void;
}

export interface SetupSubagentServiceMocksOptions {
  onResolveIdPayload?: (payload: ExtractSubjectPayload<typeof AdapterRuntimeSubjects.resolveId>) => void;
}

/**
 * Registers baseline bus handlers required by SubagentService tests.
 *
 * Handlers are intentionally centralized to keep tests focused on behavior
 * under test rather than setup duplication.
 * @param bus - Bus instance used by the tests
 * @param options - Optional overrides and capture callbacks
 * @returns Controller for overriding startAgent behavior per test case
 */
export function setupSubagentServiceMocks(
  bus: typeof import('@makaio/bus-core').MakaioBus,
  options: SetupSubagentServiceMocksOptions = {},
): SubagentServiceMockController {
  bus.on(SessionStorageSubjects.get, (ctx) => {
    ctx.setResult({
      session: {
        sessionId: ctx.payload.sessionId,
        createdAt: 0,
        lastActivityAt: 0,
        status: 'active',
        agents: [],
      },
    });
  });

  bus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
    options.onResolveIdPayload?.(ctx.payload);
    ctx.setResult({ adapterId: `resolved-${ctx.payload.adapterName}` });
  });

  bus.on(ExecutionTargetSubjects.resolve, (ctx) => {
    ctx.setResult({
      executionTarget: {
        id: 'system:local',
        name: 'Local',
        description: 'Default local process execution',
        type: 'local',
        scope: 'default',
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
      },
    });
  });

  let startAgentHandler: StartAgentHandler = (ctx) => {
    ctx.setResult({
      success: true,
      agentId: 'mock-agent',
      adapterId: String(ctx.payload.adapterId),
      adapterSessionId: 'adapter-session-1',
      sessionId: String(ctx.payload.sessionId ?? 'session-missing'),
      messageId: 'msg-1',
    });
  };

  bus.on(AdapterSubjects.startAgent, (ctx) => {
    startAgentHandler(ctx);
  });

  return {
    setStartAgentHandler: (handler) => {
      startAgentHandler = handler;
    },
  };
}
