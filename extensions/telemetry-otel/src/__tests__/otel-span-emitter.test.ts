import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter, SimpleSpanProcessor, BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { OtelSpanEmitter } from '../otel/otel-span-emitter.js';
import type { SpanDraft } from '../contracts/index.js';

describe('OtelSpanEmitter', () => {
  it('exports completed spans with hierarchy and attributes', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const emitter = new OtelSpanEmitter({ tracer: provider.getTracer('telemetry-otel-test') });

    const drafts: SpanDraft[] = [
      {
        spanId: 'execution:wfx-1',
        executionId: 'wfx-1',
        name: 'Workflow wf-1',
        kind: 'internal',
        status: 'ok',
        startedAt: 1000,
        endedAt: 2000,
        attributes: { 'makaio.execution.id': 'wfx-1' },
        links: [],
        events: [],
      },
      {
        spanId: 'frame:wfx-1:frame-1',
        parentSpanId: 'execution:wfx-1',
        executionId: 'wfx-1',
        frameId: 'frame-1',
        name: 'Frame analyze',
        kind: 'client',
        status: 'ok',
        startedAt: 1100,
        endedAt: 1900,
        attributes: { 'makaio.frame.id': 'frame-1' },
        links: [],
        events: [],
      },
    ];

    await emitter.emit(drafts);
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    expect(spans.map((span) => span.name)).toEqual(['Workflow wf-1', 'Frame analyze']);
    expect(spans[1].parentSpanContext?.spanId).toBe(spans[0].spanContext().spanId);
    expect(spans[1].attributes['makaio.frame.id']).toBe('frame-1');
  });
});
