import { AdapterSubjects, SessionSubjects } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '@makaio/services-core/adapter-runtime';
import { ExecutionTargetSubjects } from '../../execution-target/namespace.js';
import { SessionStorageSubjects } from '../../session/storage/namespace.js';
import type { ExtractSubjectPayload, ExtractSubjectResponse } from '@makaio/core';
import type { IMakaioBus } from '@makaio/bus-core';
import { SessionAgentAttachError } from '../../session/handlers/attach-error.js';

type StartAgentPayload = ExtractSubjectPayload<typeof AdapterSubjects.startAgent>;
type StartAgentResponse = ExtractSubjectResponse<typeof AdapterSubjects.startAgent>;

type StartAgentHandler = (ctx: {
  payload: StartAgentPayload;
  setResult: (result: StartAgentResponse) => void;
}) => void | Promise<void>;

export interface SubagentServiceMockController {
  setStartAgentHandler: (handler: StartAgentHandler) => void;
}

export interface SetupSubagentServiceMocksOptions {
  onResolveIdPayload?: (payload: ExtractSubjectPayload<typeof AdapterRuntimeSubjects.resolveId>) => void;
  onAttachResolvedPayload?: (payload: ExtractSubjectPayload<typeof SessionSubjects.agent.attachResolved>) => void;
  onSendMessagePayload?: (payload: ExtractSubjectPayload<typeof SessionSubjects.sendMessage>) => void;
}

/**
 * Register the session-orchestrator boundary used by subagent service tests.
 * @param bus - Test bus receiving resolved attach and first-turn requests.
 * @param options - Optional request capture callbacks.
 */
export function registerSubagentSessionOrchestrationMocks(
  bus: IMakaioBus,
  options: SetupSubagentServiceMocksOptions = {},
): void {
  bus.on(SessionSubjects.agent.attachResolved, async (ctx) => {
    options.onAttachResolvedPayload?.(ctx.payload);
    const { adapterId } = await bus.request(AdapterRuntimeSubjects.resolveId, {
      adapterName: ctx.payload.agent.adapterName ?? 'unknown-adapter',
    });
    let started;
    try {
      started = await bus.request(AdapterSubjects.startAgent, {
        adapterId,
        sessionId: ctx.payload.sessionId,
        role: ctx.payload.role ?? 'lead',
        ...(ctx.payload.harnessId !== undefined && { harnessId: ctx.payload.harnessId }),
        ...(ctx.payload.agent.providerContext !== undefined && { providerContext: ctx.payload.agent.providerContext }),
        ...(ctx.payload.agent.model !== undefined && { model: ctx.payload.agent.model }),
        ...(ctx.payload.agent.reasoningEffort !== undefined && {
          reasoningEffort: ctx.payload.agent.reasoningEffort,
        }),
        ...(ctx.payload.agent.systemPrompt !== undefined && { systemPrompt: ctx.payload.agent.systemPrompt }),
        ...(ctx.payload.agent.adapterConfig !== undefined && { adapterConfig: ctx.payload.agent.adapterConfig }),
        ...(ctx.payload.agent.cwd !== undefined && { cwd: ctx.payload.agent.cwd }),
        ...(ctx.payload.agent.allowedTools !== undefined && { allowedTools: ctx.payload.agent.allowedTools }),
        ...(ctx.payload.agent.disallowedTools !== undefined && { disallowedTools: ctx.payload.agent.disallowedTools }),
        ...(ctx.payload.agent.allowedDirectories !== undefined && {
          allowedDirectories: ctx.payload.agent.allowedDirectories,
        }),
      });
      if (!started.success) throw new Error(started.message);
    } catch (error) {
      throw new SessionAgentAttachError('agent_attach', error);
    }
    try {
      if (typeof ctx.payload.assertInitialMessageAdmission === 'function') {
        ctx.payload.assertInitialMessageAdmission();
      }
      if (ctx.payload.initialMessage !== undefined) {
        await bus.request(SessionSubjects.sendMessage, {
          sessionId: ctx.payload.sessionId,
          message: ctx.payload.initialMessage,
          source: ctx.payload.source,
          extensionId: ctx.payload.extensionId,
          responseSchema: ctx.payload.responseSchema,
        });
      }
    } catch (error) {
      throw new SessionAgentAttachError('initial_message', error);
    }
    ctx.setResult({
      agentId: started.agentId,
      adapterSessionId: started.adapterSessionId,
      role: ctx.payload.role ?? 'lead',
    });
  });
  bus.on(SessionSubjects.sendMessage, (ctx) => {
    options.onSendMessagePayload?.(ctx.payload);
    ctx.setResult({ sessionId: ctx.payload.sessionId, messageId: 'message-1', turnId: 'turn-1' });
  });
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

  bus.on(
    SessionSubjects.close,
    (ctx) => {
      ctx.setResult({ success: true });
    },
    { priority: -100 },
  );

  // Keep the production attach + first-turn seam explicit in service tests.
  registerSubagentSessionOrchestrationMocks(bus, options);

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

  bus.on(AdapterSubjects.startAgent, async (ctx) => {
    await startAgentHandler(ctx);
  });

  return {
    setStartAgentHandler: (handler) => {
      startAgentHandler = handler;
    },
  };
}
