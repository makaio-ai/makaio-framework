/**
 * End-to-end integration test for the telemetry-langfuse extension.
 *
 * Wires a real {@link TelemetryOtelService} and a real
 * {@link TelemetryLangfuseService} together without touching the Langfuse API.
 * The test verifies that Langfuse enricher rules add `gen_ai.*` attributes to
 * LLM-call spans before those spans pass through the OTel SDK pipeline to the
 * {@link InMemorySpanExporter}.
 * @packageDocumentation
 */

import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, WorkflowSubjects } from '@makaio/contracts';
import { describe, expect, it } from 'vitest';
import { DynamicSpanProcessor, TelemetryOtelService } from '@makaio/extension-telemetry-otel';
import type {
  SpanProcessorRegistration,
  TelemetryOtelProcessorRegistry,
  TelemetryOtelConfig,
} from '@makaio/extension-telemetry-otel';
import { OtelSpanEmitter } from '@makaio/extension-telemetry-otel/testing';
import type { TelemetryLangfuseConfig } from '../config.js';
import { TelemetryLangfuseService } from '../telemetry-langfuse-service.js';

/**
 * Minimal valid telemetry-otel config for integration tests.
 * @returns A {@link TelemetryOtelConfig} with low-latency batching.
 */
function otelConfig(): TelemetryOtelConfig {
  return {
    enabled: true,
    serviceName: 'integration-test',
    batchConfig: { maxExportBatchSize: 512, scheduledDelayMs: 5000, exportTimeoutMs: 30000 },
    maxOpenExecutions: 1000,
    orphanTimeoutMs: 30000,
  };
}

/**
 * Minimal valid telemetry-langfuse config for integration tests.
 *
 * No real credentials are provided; the Langfuse processor is never reached
 * because a fake registry is used for the langfuse service.
 * @returns A {@link TelemetryLangfuseConfig} with llm-only export scope.
 */
function langfuseConfig(): TelemetryLangfuseConfig {
  return {
    enabled: true,
    exportScope: 'llm-only',
    exportMode: 'batched',
  };
}

/**
 * Fake {@link TelemetryOtelProcessorRegistry} that absorbs processor
 * registrations without creating real OTel processors.
 *
 * Used to isolate the Langfuse service's enricher-rule registration from the
 * real Langfuse HTTP processor, which would make network calls in tests.
 * @returns A no-op registry.
 */
function fakeProcessorRegistry(): TelemetryOtelProcessorRegistry {
  const registrations: SpanProcessorRegistration[] = [];
  return {
    registerSpanProcessor: (registration) => {
      registrations.push(registration);
      return async () => {
        const idx = registrations.indexOf(registration);
        if (idx !== -1) {
          registrations.splice(idx, 1);
        }
      };
    },
    registeredProcessorIds: () => registrations.map((r) => r.id),
  };
}

describe('telemetry-langfuse integration', () => {
  it('adds gen_ai.* attributes to LLM-call spans before they reach registered processors', async () => {
    // ── 1. Build an OTel pipeline with an in-memory exporter ─────────────────

    const exporter = new InMemorySpanExporter();
    const dynamicProcessor = new DynamicSpanProcessor();

    // Install a SimpleSpanProcessor into the dynamic registry so exported
    // spans are immediately forwarded to the in-memory exporter.
    const unregisterInMemory = dynamicProcessor.registerSpanProcessor({
      id: 'integration-test-exporter',
      processor: new SimpleSpanProcessor(exporter),
    });

    const provider = new BasicTracerProvider({
      spanProcessors: [dynamicProcessor],
    });

    const tracer = provider.getTracer('integration-test');
    const emitter = new OtelSpanEmitter({ tracer });

    // ── 2. Wire TelemetryOtelService ─────────────────────────────────────────

    const otelService = new TelemetryOtelService({
      bus: MakaioBus,
      config: otelConfig(),
      emitter,
      processorRegistry: dynamicProcessor,
      now: () => 1000,
    });

    // ── 3. Wire TelemetryLangfuseService with a fake registry ────────────────
    //
    // The fake registry absorbs the registerSpanProcessor call so the real
    // LangfuseSpanProcessor is created but never wired into the DynamicSpanProcessor
    // that receives span lifecycle events. No HTTP calls occur because
    // LangfuseSpanProcessor.onEnd is never invoked.

    const langfuseService = new TelemetryLangfuseService({
      bus: MakaioBus,
      config: langfuseConfig(),
      telemetryOtel: fakeProcessorRegistry(),
    });

    await otelService.init();
    await langfuseService.init();

    try {
      // ── 4. Simulate a workflow execution with an LLM call ─────────────────

      await MakaioBus.emit(WorkflowSubjects.execution.started, {
        executionId: 'wfx-integration',
        workflowId: 'wf-integration',
      });

      await MakaioBus.emit(WorkflowSubjects.frame.started, {
        executionId: 'wfx-integration',
        frameId: 'frame-integration',
        nodeId: 'llm-node',
        nodeType: 'station',
        path: ['frame-integration'],
      });

      await MakaioBus.emit(WorkflowSubjects.frame.sessionLinked, {
        executionId: 'wfx-integration',
        frameId: 'frame-integration',
        sessionId: 'sess-integration',
      });

      await MakaioBus.emit(AgentSubjects.usage, {
        agentId: 'agent-integration',
        adapterId: 'adapter-integration',
        adapterName: 'openai',
        adapterSessionId: 'native-sess-integration',
        sessionId: 'sess-integration',
        provider: 'openai',
        model: 'gpt-5.4',
        inputTokens: 100,
        inputCachedTokens: 0,
        outputTokens: 50,
        reasoningTokens: 0,
        totalTokens: 150,
        costUnits: 150,
        costUnitType: 'tokens',
      });

      await MakaioBus.emit(WorkflowSubjects.execution.completed, {
        executionId: 'wfx-integration',
        totalDuration: 1000,
      });

      // ── 5. Force-flush the OTel pipeline ──────────────────────────────────

      await provider.forceFlush();

      // ── 6. Assert GenAI attributes are present on the LLM-call span ───────

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBeGreaterThan(0);

      const llmSpan = spans.find((s) => s.name === 'LLM call gpt-5.4');
      expect(llmSpan).toBeDefined();

      // Enricher rule 'telemetry-langfuse.gen-ai-llm' maps llm.* → gen_ai.*
      expect(llmSpan?.attributes['gen_ai.operation.name']).toBe('chat');
      expect(llmSpan?.attributes['gen_ai.provider.name']).toBe('openai');
      expect(llmSpan?.attributes['gen_ai.request.model']).toBe('gpt-5.4');
      expect(llmSpan?.attributes['gen_ai.response.model']).toBe('gpt-5.4');
      expect(llmSpan?.attributes['gen_ai.usage.input_tokens']).toBe(100);
      expect(llmSpan?.attributes['gen_ai.usage.output_tokens']).toBe(50);
      expect(llmSpan?.attributes['gen_ai.usage.total_tokens']).toBe(150);
      expect(llmSpan?.attributes['langfuse.session.id']).toBe('sess-integration');
    } finally {
      // ── 7. Clean up services and OTel infrastructure ──────────────────────
      await langfuseService.destroy();
      await otelService.destroy();
      await unregisterInMemory();
      await provider.shutdown();
    }
  });
});
