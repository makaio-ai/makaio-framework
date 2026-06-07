import { describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, WorkflowSubjects } from '@makaio/contracts';
import { TelemetryOtelService } from '../telemetry-otel-service.js';
import { TelemetryOtelSubjects, type SpanDraft } from '../contracts/index.js';
import type { TelemetryOtelConfig } from '../config.js';
import type { SpanProcessorRegistration, TelemetryOtelProcessorRegistry } from '../otel/dynamic-span-processor.js';

function baseConfig(overrides: Partial<TelemetryOtelConfig> = {}): TelemetryOtelConfig {
  return {
    enabled: true,
    otlpEndpoint: 'http://localhost:4318/v1/traces',
    serviceName: 'makaio-test',
    batchConfig: { maxExportBatchSize: 512, scheduledDelayMs: 5000, exportTimeoutMs: 30000 },
    maxOpenExecutions: 1000,
    orphanTimeoutMs: 30000,
    ...overrides,
  };
}

const processorRegistration: SpanProcessorRegistration = {
  id: 'langfuse',
  processor: {
    onStart: () => {},
    onEnd: () => {},
    forceFlush: async () => {},
    shutdown: async () => {},
  },
};

describe('TelemetryOtelService', () => {
  it('delegates span processor registration to the injected registry and returns its unregister cleanup', async () => {
    const unregister = vi.fn(async () => {});
    const registry: TelemetryOtelProcessorRegistry = {
      registerSpanProcessor: vi.fn(() => unregister),
      registeredProcessorIds: vi.fn(() => ['langfuse']),
    };
    const service = new TelemetryOtelService({
      bus: MakaioBus,
      config: baseConfig(),
      emitter: {
        emit: async () => {},
      },
      processorRegistry: registry,
    });

    const cleanup = service.registerSpanProcessor(processorRegistration);
    await cleanup();

    expect(registry.registerSpanProcessor).toHaveBeenCalledWith(processorRegistration);
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(service.registeredProcessorIds()).toEqual(['langfuse']);
  });

  it('throws when registering a span processor without a processor registry', () => {
    const service = new TelemetryOtelService({
      bus: MakaioBus,
      config: baseConfig(),
      emitter: {
        emit: async () => {},
      },
    });

    expect(() => service.registerSpanProcessor(processorRegistration)).toThrow(
      'telemetry-otel was started without a processor registry',
    );
  });

  it('subscribes to bus events and exports enriched span drafts on terminal execution', async () => {
    const exported: SpanDraft[][] = [];
    const service = new TelemetryOtelService({
      bus: MakaioBus,
      config: baseConfig(),
      emitter: {
        emit: async (drafts) => {
          exported.push([...drafts]);
        },
      },
      now: () => 2000,
    });

    await service.init();
    try {
      await MakaioBus.emit(WorkflowSubjects.execution.started, { executionId: 'wfx-1', workflowId: 'wf-1' });
      await MakaioBus.emit(WorkflowSubjects.frame.started, {
        executionId: 'wfx-1',
        frameId: 'frame-1',
        nodeId: 'analyze',
        nodeType: 'station',
        path: ['frame-1'],
      });
      await MakaioBus.emit(WorkflowSubjects.frame.sessionLinked, {
        executionId: 'wfx-1',
        frameId: 'frame-1',
        sessionId: 'sess-child',
      });
      await MakaioBus.emit(AgentSubjects.usage, {
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'openai',
        adapterSessionId: 'native-sess-1',
        sessionId: 'sess-child',
        provider: 'openai',
        model: 'gpt-5.4',
        inputTokens: 1,
        inputCachedTokens: 0,
        outputTokens: 2,
        reasoningTokens: 0,
        totalTokens: 3,
        costUnits: 3,
        costUnitType: 'tokens',
      });
      await MakaioBus.emit(WorkflowSubjects.execution.completed, {
        executionId: 'wfx-1',
        workflowId: 'wf-1',
        totalDuration: 1000,
      });

      expect(exported).toHaveLength(1);
      expect(exported[0]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ spanId: 'execution:wfx-1' }),
          expect.objectContaining({ name: 'LLM call gpt-5.4' }),
        ]),
      );
    } finally {
      await service.destroy();
    }
  });

  it('uses workflow execution event timestamps instead of handler receipt time', async () => {
    const exported: SpanDraft[][] = [];
    const service = new TelemetryOtelService({
      bus: MakaioBus,
      config: baseConfig(),
      emitter: {
        emit: async (drafts) => {
          exported.push([...drafts]);
        },
      },
      now: () => 9000,
    });

    await service.init();
    try {
      await MakaioBus.emit(WorkflowSubjects.execution.started, {
        executionId: 'wfx-execution-time',
        workflowId: 'wf-execution-time',
        startedAt: 1000,
      });
      await MakaioBus.emit(WorkflowSubjects.execution.completed, {
        executionId: 'wfx-execution-time',
        workflowId: 'wf-execution-time',
        totalDuration: 800,
        completedAt: 1800,
      });

      const executionSpan = exported[0]?.find((draft) => draft.spanId === 'execution:wfx-execution-time');
      expect(executionSpan).toEqual(
        expect.objectContaining({
          startedAt: 1000,
          endedAt: 1800,
        }),
      );
    } finally {
      await service.destroy();
    }
  });

  it('uses workflow frame event timestamps instead of handler receipt time', async () => {
    const exported: SpanDraft[][] = [];
    const service = new TelemetryOtelService({
      bus: MakaioBus,
      config: baseConfig(),
      emitter: {
        emit: async (drafts) => {
          exported.push([...drafts]);
        },
      },
      now: () => 9000,
    });

    await service.init();
    try {
      await MakaioBus.emit(WorkflowSubjects.execution.started, {
        executionId: 'wfx-frame-time',
        workflowId: 'wf-frame-time',
      });
      await MakaioBus.emit(WorkflowSubjects.frame.started, {
        executionId: 'wfx-frame-time',
        frameId: 'frame-time',
        nodeId: 'analyze',
        nodeType: 'station',
        path: ['frame-time'],
        startedAt: 1200,
      });
      await MakaioBus.emit(WorkflowSubjects.frame.completed, {
        executionId: 'wfx-frame-time',
        frameId: 'frame-time',
        nodeId: 'analyze',
        duration: 300,
        completedAt: 1500,
      });
      await MakaioBus.emit(WorkflowSubjects.execution.completed, {
        executionId: 'wfx-frame-time',
        workflowId: 'wf-frame-time',
        totalDuration: 1000,
      });

      const frameSpan = exported[0]?.find((draft) => draft.spanId === 'frame:wfx-frame-time:frame-time');
      expect(frameSpan).toEqual(
        expect.objectContaining({
          startedAt: 1200,
          endedAt: 1500,
        }),
      );
    } finally {
      await service.destroy();
    }
  });

  it('exports agent tool spans through service wiring', async () => {
    const exported: SpanDraft[][] = [];
    const service = new TelemetryOtelService({
      bus: MakaioBus,
      config: baseConfig(),
      emitter: {
        emit: async (drafts) => {
          exported.push([...drafts]);
        },
      },
      now: () => 2000,
    });

    await service.init();
    try {
      await MakaioBus.emit(WorkflowSubjects.execution.started, {
        executionId: 'wfx-tool-service',
        workflowId: 'wf-tool-service',
      });
      await MakaioBus.emit(WorkflowSubjects.frame.started, {
        executionId: 'wfx-tool-service',
        frameId: 'frame-1',
        nodeId: 'analyze',
        nodeType: 'station',
        path: ['frame-1'],
      });
      await MakaioBus.emit(WorkflowSubjects.frame.sessionLinked, {
        executionId: 'wfx-tool-service',
        frameId: 'frame-1',
        sessionId: 'sess-tool-service',
      });
      await MakaioBus.emit(AgentSubjects.tool.started, {
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'openai',
        adapterSessionId: 'native-sess-1',
        sessionId: 'sess-tool-service',
        toolName: 'read',
        toolCallId: 'call-service',
      });
      await MakaioBus.emit(AgentSubjects.tool.completed, {
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'openai',
        adapterSessionId: 'native-sess-1',
        sessionId: 'sess-tool-service',
        toolName: 'read',
        toolCallId: 'call-service',
        result: 'ok',
        success: true,
      });
      await MakaioBus.emit(WorkflowSubjects.execution.completed, {
        executionId: 'wfx-tool-service',
        workflowId: 'wf-tool-service',
        totalDuration: 1000,
      });

      expect(exported[0]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            spanId: 'tool:wfx-tool-service:sess-tool-service:call-service',
            parentSpanId: 'frame:wfx-tool-service:frame-1',
          }),
        ]),
      );
    } finally {
      await service.destroy();
    }
  });

  it('logs enricher handler errors without rejecting workflow terminal events', async () => {
    const exported: SpanDraft[][] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cleanup = MakaioBus.on(TelemetryOtelSubjects.enrichSpan, () => {
      throw new Error('enricher failed');
    });
    const service = new TelemetryOtelService({
      bus: MakaioBus,
      config: baseConfig(),
      emitter: {
        emit: async (drafts) => {
          exported.push([...drafts]);
        },
      },
      now: () => 2000,
    });

    await service.init();
    try {
      await MakaioBus.emit(WorkflowSubjects.execution.started, { executionId: 'wfx-enrich-error', workflowId: 'wf-1' });
      await expect(
        MakaioBus.emit(WorkflowSubjects.execution.completed, {
          executionId: 'wfx-enrich-error',
          workflowId: 'wf-1',
          totalDuration: 1000,
        }),
      ).resolves.toBeUndefined();
      expect(exported).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        "[telemetry-otel] Failed to export terminal 'completed' telemetry",
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
      cleanup();
      await service.destroy();
    }
  });

  it('logs eviction export failures without rejecting execution start events', async () => {
    let failNextEmit = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new TelemetryOtelService({
      bus: MakaioBus,
      config: baseConfig({ maxOpenExecutions: 1 }),
      emitter: {
        emit: async () => {
          if (failNextEmit) {
            failNextEmit = false;
            throw new Error('eviction export failed');
          }
        },
      },
      now: () => 2000,
    });

    await service.init();
    try {
      await MakaioBus.emit(WorkflowSubjects.execution.started, { executionId: 'wfx-evict-a', workflowId: 'wf-1' });
      await expect(
        MakaioBus.emit(WorkflowSubjects.execution.started, { executionId: 'wfx-evict-b', workflowId: 'wf-1' }),
      ).resolves.toBeUndefined();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(warn).toHaveBeenCalledWith(
        "[telemetry-otel] Failed to export terminal 'evicted' telemetry",
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
      await service.destroy();
    }
  });

  it('does not wait for eviction export before resolving execution start events', async () => {
    const exported: SpanDraft[][] = [];
    const shutdown = vi.fn(async () => {});
    let exportStarted = false;
    let releaseExport = (): void => {};
    const exportGate = new Promise<void>((resolve) => {
      releaseExport = resolve;
    });
    let destroyEvent: Promise<void> | undefined;
    const service = new TelemetryOtelService({
      bus: MakaioBus,
      config: baseConfig({ maxOpenExecutions: 1 }),
      emitter: {
        emit: async (drafts) => {
          exportStarted = true;
          await exportGate;
          exported.push([...drafts]);
        },
        shutdown,
      },
      now: () => 2000,
    });

    await service.init();
    try {
      await MakaioBus.emit(WorkflowSubjects.execution.started, { executionId: 'wfx-evict-a', workflowId: 'wf-1' });
      const startEvent = MakaioBus.emit(WorkflowSubjects.execution.started, {
        executionId: 'wfx-evict-b',
        workflowId: 'wf-1',
      });
      let startResolved = false;
      void startEvent.then(() => {
        startResolved = true;
      });

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

      expect(exportStarted).toBe(true);
      expect(startResolved).toBe(true);
      expect(exported).toHaveLength(0);

      destroyEvent = service.destroy();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(shutdown).not.toHaveBeenCalled();

      releaseExport();
      await startEvent;
      await destroyEvent;

      expect(exported).toHaveLength(2);
      expect(shutdown).toHaveBeenCalledTimes(1);
    } finally {
      releaseExport();
      await (destroyEvent ?? service.destroy());
    }
  });

  it('flushes open executions, shuts down the emitter, and unregisters handlers on destroy', async () => {
    const exported: SpanDraft[][] = [];
    const shutdown = vi.fn(async () => {});
    const service = new TelemetryOtelService({
      bus: MakaioBus,
      config: baseConfig(),
      emitter: {
        emit: async (drafts) => {
          exported.push([...drafts]);
        },
        shutdown,
      },
      now: () => 3000,
    });

    await service.init();
    await MakaioBus.emit(WorkflowSubjects.execution.started, { executionId: 'wfx-destroy', workflowId: 'wf-1' });
    await service.destroy();

    expect(exported).toHaveLength(1);
    expect(exported[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ spanId: 'execution:wfx-destroy', status: 'error' })]),
    );
    expect(shutdown).toHaveBeenCalledTimes(1);

    await MakaioBus.emit(WorkflowSubjects.execution.started, { executionId: 'wfx-after-destroy', workflowId: 'wf-1' });
    await MakaioBus.emit(WorkflowSubjects.execution.completed, {
      executionId: 'wfx-after-destroy',
      workflowId: 'wf-1',
      totalDuration: 1000,
    });
    expect(exported).toHaveLength(1);
  });

  it('still shuts down the emitter when destroy-time flush export fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shutdown = vi.fn(async () => {});
    let destroyed = false;
    const service = new TelemetryOtelService({
      bus: MakaioBus,
      config: baseConfig(),
      emitter: {
        emit: async () => {
          throw new Error('shutdown export failed');
        },
        shutdown,
      },
      now: () => 3000,
    });

    await service.init();
    try {
      await MakaioBus.emit(WorkflowSubjects.execution.started, { executionId: 'wfx-destroy-fail', workflowId: 'wf-1' });
      await expect(service.destroy()).resolves.toBeUndefined();
      destroyed = true;

      expect(warn).toHaveBeenCalledWith(
        "[telemetry-otel] Failed to export terminal 'shutdown' telemetry",
        expect.any(Error),
      );
      expect(shutdown).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      if (!destroyed) {
        await service.destroy();
      }
    }
  });
});
