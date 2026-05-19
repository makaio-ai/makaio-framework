/// <reference types="bun-types" />
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, type AgentToolApproveRequest } from '@makaio/contracts';
import { createClaudeConnectorNamespace } from '../namespace/index.js';
import { registerToolApprovalHandler, toGlobalToolApproval } from './tool-handling.js';

describe('toGlobalToolApproval', () => {
  it('applies full context identity while preserving non-identity payload fields', () => {
    const payload: AgentToolApproveRequest = {
      adapterId: 'adapter-1',
      adapterName: 'claude-code',
      adapterSessionId: 'session-1',
      agentId: 'agent-1',
      sessionId: 'test-session-id',
      toolCallId: 'tool-1',
      toolName: 'Read',
      args: { path: '/tmp/a.ts' },
    };

    // Production callers always provide full context (all 5 identity fields);
    // mergeScopedToolApproval requires context-sourced identity by default.
    expect(
      toGlobalToolApproval(payload, {
        adapterId: 'adapter-override',
        adapterName: 'claude-override',
        adapterSessionId: 'session-override',
        agentId: 'agent-override',
        sessionId: 'context-session-id',
      }),
    ).toEqual({
      ...payload,
      adapterId: 'adapter-override',
      adapterName: 'claude-override',
      adapterSessionId: 'session-override',
      agentId: 'agent-override',
      sessionId: 'context-session-id',
    });
  });
});

describe('registerToolApprovalHandler', () => {
  afterEach(() => {
    mock.restore();
  });

  it('supports async partial context providers and forwards merged payload to global approval', async () => {
    const namespace = createClaudeConnectorNamespace(
      `adapter:claude-shared-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const unsubscribe = mock();
    const on = mock((_subject, _handler) => unsubscribe);
    const connector = { on };

    const requestSpy = spyOn(MakaioBus, 'request').mockResolvedValue({ action: 'allow' });

    const cleanup = registerToolApprovalHandler(connector, namespace.subjects, async () => ({
      adapterId: 'adapter-override',
      adapterName: 'claude-override',
      adapterSessionId: 'session-override',
      agentId: 'agent-override',
      sessionId: 'context-session-id',
    }));

    const handler = on.mock.calls[0]?.[1] as
      | ((ctx: { payload: AgentToolApproveRequest; setResult: (result: unknown) => void }) => Promise<void>)
      | undefined;
    expect(handler).toBeDefined();

    const setResult = mock();
    const payload: AgentToolApproveRequest = {
      adapterId: 'adapter-1',
      adapterName: 'claude-code',
      adapterSessionId: 'session-1',
      agentId: 'agent-1',
      sessionId: 'test-session-id',
      toolCallId: 'tool-1',
      toolName: 'Read',
      args: { path: '/tmp/a.ts' },
    };

    await handler!({ payload, setResult });

    expect(requestSpy).toHaveBeenCalledWith(AgentSubjects.toolApprove, {
      ...payload,
      adapterId: 'adapter-override',
      adapterName: 'claude-override',
      adapterSessionId: 'session-override',
      agentId: 'agent-override',
      sessionId: 'context-session-id',
    });
    expect(setResult).toHaveBeenCalledWith({ action: 'allow' });

    cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('denies tool usage when approval backend throws', async () => {
    const namespace = createClaudeConnectorNamespace(
      `adapter:claude-shared-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const on = mock((_subject, _handler) => () => {});
    const connector = { on };
    spyOn(MakaioBus, 'request').mockRejectedValue(new Error('down'));

    registerToolApprovalHandler(connector, namespace.subjects, {
      adapterId: 'adapter-1',
      adapterName: 'claude-code',
      adapterSessionId: 'session-1',
      agentId: 'agent-1',
      sessionId: 'context-session-id',
    });

    const handler = on.mock.calls[0]?.[1] as
      | ((ctx: { payload: AgentToolApproveRequest; setResult: (result: unknown) => void }) => Promise<void>)
      | undefined;
    expect(handler).toBeDefined();

    const setResult = mock();
    await handler!({
      payload: {
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
        adapterSessionId: 'session-1',
        agentId: 'agent-1',
        sessionId: 'test-session-id',
        toolCallId: 'tool-1',
        toolName: 'Read',
        args: { path: '/tmp/a.ts' },
      },
      setResult,
    });

    expect(setResult).toHaveBeenCalledWith({
      action: 'deny',
      message: 'Tool approval request failed: down',
      shouldAbort: true,
    });
  });

  it('denies tool usage when context provider throws before approval request', async () => {
    const namespace = createClaudeConnectorNamespace(
      `adapter:claude-shared-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const on = mock((_subject, _handler) => () => {});
    const connector = { on };
    const requestSpy = spyOn(MakaioBus, 'request').mockResolvedValue({ action: 'allow' });

    registerToolApprovalHandler(connector, namespace.subjects, async () => {
      throw new Error('context unavailable');
    });

    const handler = on.mock.calls[0]?.[1] as
      | ((ctx: { payload: AgentToolApproveRequest; setResult: (result: unknown) => void }) => Promise<void>)
      | undefined;
    expect(handler).toBeDefined();

    const setResult = mock();
    await handler!({
      payload: {
        adapterId: 'adapter-1',
        adapterName: 'claude-code',
        adapterSessionId: 'session-1',
        agentId: 'agent-1',
        sessionId: 'test-session-id',
        toolCallId: 'tool-1',
        toolName: 'Read',
        args: { path: '/tmp/a.ts' },
      },
      setResult,
    });

    expect(requestSpy).not.toHaveBeenCalled();
    expect(setResult).toHaveBeenCalledWith({
      action: 'deny',
      message: 'Tool approval request failed: context unavailable',
      shouldAbort: true,
    });
  });
});
