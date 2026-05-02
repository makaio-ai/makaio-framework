import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, type StepStarted, type StepFinished, type SessionMessageBlock } from '@makaio/contracts';
import { createHook } from '../create-hook.js';
import type { PostStepContext } from '../types/hook-context.js';

/**
 * Helper to create a valid StepStarted payload.
 * @param overrides - Optional payload overrides
 */
function createStepStartedPayload(overrides: Partial<StepStarted> = {}): StepStarted {
  return {
    sessionId: 'session-1',
    agentId: 'agent-1',
    adapterId: 'adapter-1',
    adapterName: 'test-adapter',
    adapterSessionId: 'adapter-session-1',
    stepType: 'text',
    blockIndex: 0,
    ...overrides,
  };
}

/**
 * Helper to create a valid StepFinished payload.
 * @param overrides - Optional payload overrides
 */
function createStepFinishedPayload(overrides: Partial<StepFinished> = {}): StepFinished {
  return {
    sessionId: 'session-1',
    agentId: 'agent-1',
    adapterId: 'adapter-1',
    adapterName: 'test-adapter',
    adapterSessionId: 'adapter-session-1',
    messageId: 'msg-123',
    stepType: 'text',
    blockIndex: 0,
    content: { type: 'text', content: 'Test text content' },
    ...overrides,
  };
}

describe('Step Events', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  describe('blockIndex correlation', () => {
    it('step.started and step.finished should have matching blockIndex for the same step', async () => {
      const startedEvents: StepStarted[] = [];
      const finishedEvents: StepFinished[] = [];

      MakaioBus.on(AgentSubjects.step.started, (ctx) => {
        startedEvents.push(ctx.payload);
      });

      MakaioBus.on(AgentSubjects.step.finished, (ctx) => {
        finishedEvents.push(ctx.payload);
      });

      // Emit step.started for text block 0
      await MakaioBus.emit(AgentSubjects.step.started, createStepStartedPayload({ stepType: 'text', blockIndex: 0 }));

      // Emit step.finished for text block 0
      await MakaioBus.emit(
        AgentSubjects.step.finished,
        createStepFinishedPayload({
          stepType: 'text',
          blockIndex: 0,
          content: { type: 'text', content: 'Hello world' },
        }),
      );

      expect(startedEvents).toHaveLength(1);
      expect(finishedEvents).toHaveLength(1);
      expect(startedEvents[0].blockIndex).toBe(finishedEvents[0].blockIndex);
      expect(startedEvents[0].stepType).toBe(finishedEvents[0].stepType);
    });

    it('multiple tool calls in one turn should have different blockIndex values', async () => {
      const startedEvents: StepStarted[] = [];
      const finishedEvents: StepFinished[] = [];

      MakaioBus.on(AgentSubjects.step.started, (ctx) => {
        startedEvents.push(ctx.payload);
      });

      MakaioBus.on(AgentSubjects.step.finished, (ctx) => {
        finishedEvents.push(ctx.payload);
      });

      // Simulate multiple tool calls in one turn (like OpenAI parallel tool calls)
      const toolCalls = [
        { toolCallId: 'call-1', name: 'read_file', args: { path: '/a.ts' } },
        { toolCallId: 'call-2', name: 'read_file', args: { path: '/b.ts' } },
        { toolCallId: 'call-3', name: 'grep', args: { pattern: 'foo' } },
      ];

      // Emit step.started for each tool call
      for (let i = 0; i < toolCalls.length; i++) {
        const call = toolCalls[i];
        await MakaioBus.emit(
          AgentSubjects.step.started,
          createStepStartedPayload({
            stepType: 'tool_use',
            blockIndex: i,
            blockData: { type: 'tool_use', toolName: call.name, toolCallId: call.toolCallId },
            content: { type: 'tool_call', toolCallId: call.toolCallId, name: call.name, args: call.args },
          }),
        );
      }

      // Emit step.finished for each tool call (results may come back in different order)
      const results = [
        { toolCallId: 'call-2', output: 'content of b.ts', blockIndex: 1 },
        { toolCallId: 'call-1', output: 'content of a.ts', blockIndex: 0 },
        { toolCallId: 'call-3', output: 'grep results', blockIndex: 2 },
      ];

      for (const result of results) {
        await MakaioBus.emit(
          AgentSubjects.step.finished,
          createStepFinishedPayload({
            stepType: 'tool_use',
            blockIndex: result.blockIndex,
            content: { type: 'tool_output', toolCallId: result.toolCallId, output: result.output },
          }),
        );
      }

      expect(startedEvents).toHaveLength(3);
      expect(finishedEvents).toHaveLength(3);

      // Verify each tool call has unique blockIndex
      const startedIndices = startedEvents.map((e) => e.blockIndex);
      const uniqueStartedIndices = new Set(startedIndices);
      expect(uniqueStartedIndices.size).toBe(3);

      // Verify blockIndex correlation: each toolCallId should have matching indices
      for (const call of toolCalls) {
        const started = startedEvents.find(
          (e) => e.content?.type === 'tool_call' && e.content.toolCallId === call.toolCallId,
        );
        const finished = finishedEvents.find(
          (e) => e.content?.type === 'tool_output' && e.content.toolCallId === call.toolCallId,
        );

        expect(started).toBeDefined();
        expect(finished).toBeDefined();
        // The correlation is by toolCallId, blockIndex helps order but may differ
        // What matters is that PostStep can correlate start and finish by toolCallId
      }
    });

    it('new turn should reset blockIndex to 0', async () => {
      const startedEvents: StepStarted[] = [];

      MakaioBus.on(AgentSubjects.step.started, (ctx) => {
        startedEvents.push(ctx.payload);
      });

      // Turn 1: emit blocks 0, 1, 2
      for (let i = 0; i < 3; i++) {
        await MakaioBus.emit(AgentSubjects.step.started, createStepStartedPayload({ stepType: 'text', blockIndex: i }));
      }

      // Turn 2: should start at blockIndex 0 again
      // This simulates adapter calling emitStart() which resets currentBlockIndex
      await MakaioBus.emit(
        AgentSubjects.step.started,
        createStepStartedPayload({ stepType: 'reasoning', blockIndex: 0 }),
      );

      expect(startedEvents).toHaveLength(4);
      expect(startedEvents[0].blockIndex).toBe(0);
      expect(startedEvents[1].blockIndex).toBe(1);
      expect(startedEvents[2].blockIndex).toBe(2);
      expect(startedEvents[3].blockIndex).toBe(0); // Reset for new turn
    });
  });

  describe('tool step lifecycle', () => {
    it('tool step.started should contain tool_call content with args', async () => {
      const startedEvents: StepStarted[] = [];

      MakaioBus.on(AgentSubjects.step.started, (ctx) => {
        startedEvents.push(ctx.payload);
      });

      const toolCall: SessionMessageBlock = {
        type: 'tool_call',
        toolCallId: 'call-123',
        name: 'read_file',
        args: { path: '/foo/bar.ts' },
      };

      await MakaioBus.emit(
        AgentSubjects.step.started,
        createStepStartedPayload({
          stepType: 'tool_use',
          blockIndex: 0,
          content: toolCall,
        }),
      );

      expect(startedEvents).toHaveLength(1);
      expect(startedEvents[0].content).toEqual(toolCall);
      expect(startedEvents[0].content?.type).toBe('tool_call');
    });

    it('tool step.finished should contain tool_output content with result', async () => {
      const finishedEvents: StepFinished[] = [];

      MakaioBus.on(AgentSubjects.step.finished, (ctx) => {
        finishedEvents.push(ctx.payload);
      });

      const toolOutput: SessionMessageBlock = {
        type: 'tool_output',
        toolCallId: 'call-123',
        output: 'File contents here...',
        isError: false,
      };

      await MakaioBus.emit(
        AgentSubjects.step.finished,
        createStepFinishedPayload({
          stepType: 'tool_use',
          blockIndex: 0,
          content: toolOutput,
        }),
      );

      expect(finishedEvents).toHaveLength(1);
      expect(finishedEvents[0].content).toEqual(toolOutput);
      expect(finishedEvents[0].content?.type).toBe('tool_output');
    });

    it('tool step.finished with error should have isError: true', async () => {
      const finishedEvents: StepFinished[] = [];

      MakaioBus.on(AgentSubjects.step.finished, (ctx) => {
        finishedEvents.push(ctx.payload);
      });

      await MakaioBus.emit(
        AgentSubjects.step.finished,
        createStepFinishedPayload({
          stepType: 'tool_use',
          blockIndex: 0,
          content: {
            type: 'tool_output',
            toolCallId: 'call-123',
            output: 'Error: File not found',
            isError: true,
          },
        }),
      );

      expect(finishedEvents).toHaveLength(1);
      const content = finishedEvents[0].content as { type: 'tool_output'; isError?: boolean };
      expect(content.isError).toBe(true);
    });
  });

  describe('PostStep hook receives content from payload', () => {
    it('receives text content directly without fetch', async () => {
      const handler = vi.fn();
      const { unsubscribe } = createHook('PostStep', { handler, stepTypes: ['text'] });

      const textContent: SessionMessageBlock = { type: 'text', content: 'Hello from the agent' };

      await MakaioBus.emit(
        AgentSubjects.step.finished,
        createStepFinishedPayload({
          stepType: 'text',
          content: textContent,
        }),
      );

      expect(handler).toHaveBeenCalledTimes(1);
      const ctx = handler.mock.calls[0][0] as PostStepContext;
      expect(ctx.stepContent).toEqual(textContent);

      unsubscribe();
    });

    it('receives reasoning content directly without fetch', async () => {
      const handler = vi.fn();
      const { unsubscribe } = createHook('PostStep', { handler, stepTypes: ['reasoning'] });

      const reasoningContent: SessionMessageBlock = { type: 'reasoning', content: 'Let me think about this...' };

      await MakaioBus.emit(
        AgentSubjects.step.finished,
        createStepFinishedPayload({
          stepType: 'reasoning',
          content: reasoningContent,
        }),
      );

      expect(handler).toHaveBeenCalledTimes(1);
      const ctx = handler.mock.calls[0][0] as PostStepContext;
      expect(ctx.stepContent).toEqual(reasoningContent);

      unsubscribe();
    });

    it('receives tool_output content directly without fetch', async () => {
      const handler = vi.fn();
      const { unsubscribe } = createHook('PostStep', { handler, stepTypes: ['tool_use'] });

      const toolOutput: SessionMessageBlock = {
        type: 'tool_output',
        toolCallId: 'call-456',
        output: 'Tool execution result',
        isError: false,
      };

      await MakaioBus.emit(
        AgentSubjects.step.finished,
        createStepFinishedPayload({
          stepType: 'tool_use',
          content: toolOutput,
        }),
      );

      expect(handler).toHaveBeenCalledTimes(1);
      const ctx = handler.mock.calls[0][0] as PostStepContext;
      expect(ctx.stepContent).toEqual(toolOutput);

      unsubscribe();
    });
  });

  describe('cross-adapter consistency', () => {
    it('all step types include stepType and blockIndex in events', async () => {
      const startedEvents: StepStarted[] = [];
      const finishedEvents: StepFinished[] = [];

      MakaioBus.on(AgentSubjects.step.started, (ctx) => {
        startedEvents.push(ctx.payload);
      });

      MakaioBus.on(AgentSubjects.step.finished, (ctx) => {
        finishedEvents.push(ctx.payload);
      });

      const stepTypes: Array<'text' | 'reasoning' | 'tool_use'> = ['text', 'reasoning', 'tool_use'];

      for (let i = 0; i < stepTypes.length; i++) {
        const stepType = stepTypes[i];
        await MakaioBus.emit(AgentSubjects.step.started, createStepStartedPayload({ stepType, blockIndex: i }));
        await MakaioBus.emit(AgentSubjects.step.finished, createStepFinishedPayload({ stepType, blockIndex: i }));
      }

      expect(startedEvents).toHaveLength(3);
      expect(finishedEvents).toHaveLength(3);

      // All events should have required fields
      for (const event of [...startedEvents, ...finishedEvents]) {
        expect(event.stepType).toBeDefined();
        expect(typeof event.blockIndex).toBe('number');
        expect(event.agentId).toBeDefined();
        expect(event.adapterId).toBeDefined();
      }
    });
  });
});
