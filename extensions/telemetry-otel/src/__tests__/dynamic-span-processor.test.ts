import { ROOT_CONTEXT, trace, type Context } from '@opentelemetry/api';
import { BasicTracerProvider, type ReadableSpan, type Span, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it, vi } from 'vitest';
import { DynamicSpanProcessor } from '../otel/dynamic-span-processor.js';

function createProcessor(
  label: string,
  failures: {
    readonly onStart?: Error;
    readonly onEnd?: Error;
  } = {},
): SpanProcessor & {
  readonly starts: string[];
  readonly ends: string[];
  readonly startNames: string[];
  readonly endNames: string[];
  readonly forceFlushMock: ReturnType<typeof vi.fn>;
  readonly shutdownMock: ReturnType<typeof vi.fn>;
} {
  const forceFlushMock = vi.fn(async () => {});
  const shutdownMock = vi.fn(async () => {});
  const starts: string[] = [];
  const ends: string[] = [];
  const startNames: string[] = [];
  const endNames: string[] = [];

  return {
    starts,
    ends,
    startNames,
    endNames,
    forceFlushMock,
    shutdownMock,
    onStart: (span: Span, _parentContext: Context) => {
      starts.push(label);
      startNames.push(span.name);
      if (failures.onStart !== undefined) {
        throw failures.onStart;
      }
    },
    onEnd: (span: ReadableSpan) => {
      ends.push(label);
      endNames.push(span.name);
      if (failures.onEnd !== undefined) {
        throw failures.onEnd;
      }
    },
    forceFlush: forceFlushMock,
    shutdown: shutdownMock,
  };
}

describe('DynamicSpanProcessor', () => {
  it('forwards span lifecycle calls to registered processors', () => {
    const dynamic = new DynamicSpanProcessor();
    const processor = createProcessor('langfuse');
    dynamic.registerSpanProcessor({ id: 'langfuse', processor });

    const span = trace.getTracer('dynamic-test').startSpan('test-span');
    dynamic.onStart(span as unknown as Span, ROOT_CONTEXT);
    span.end();
    dynamic.onEnd(span as unknown as ReadableSpan);

    expect(processor.starts).toEqual(['langfuse']);
    expect(processor.ends).toEqual(['langfuse']);
  });

  it('supports runtime child registration after BasicTracerProvider construction', async () => {
    const dynamic = new DynamicSpanProcessor();
    const provider = new BasicTracerProvider({
      spanProcessors: [dynamic],
    });
    const tracer = provider.getTracer('dynamic-provider-test');
    const startedBeforeRegistration = tracer.startSpan('started-before-registration');
    const processor = createProcessor('langfuse');
    const unregister = dynamic.registerSpanProcessor({ id: 'langfuse', processor });

    try {
      const deliveredAfterRegistration = tracer.startSpan('delivered-after-registration');
      deliveredAfterRegistration.end();
      startedBeforeRegistration.end();

      expect(processor.startNames).toEqual(['delivered-after-registration']);
      expect(processor.endNames).toEqual(['delivered-after-registration', 'started-before-registration']);

      await unregister();

      const afterUnregister = tracer.startSpan('after-unregister');
      afterUnregister.end();

      expect(processor.startNames).toEqual(['delivered-after-registration']);
      expect(processor.endNames).toEqual(['delivered-after-registration', 'started-before-registration']);
    } finally {
      await provider.shutdown();
    }
  });

  it('continues onStart fanout after a child processor throws synchronously', () => {
    const dynamic = new DynamicSpanProcessor();
    const first = createProcessor('first');
    const throwing = createProcessor('throwing', { onStart: new Error('start failed') });
    const later = createProcessor('later');
    dynamic.registerSpanProcessor({ id: 'first', processor: first });
    dynamic.registerSpanProcessor({ id: 'throwing', processor: throwing });
    dynamic.registerSpanProcessor({ id: 'later', processor: later });

    const span = trace.getTracer('dynamic-test').startSpan('test-span');
    expect(() => dynamic.onStart(span as unknown as Span, ROOT_CONTEXT)).not.toThrow();

    expect(first.starts).toEqual(['first']);
    expect(throwing.starts).toEqual(['throwing']);
    expect(later.starts).toEqual(['later']);
  });

  it('continues onEnd fanout after a child processor throws synchronously', () => {
    const dynamic = new DynamicSpanProcessor();
    const first = createProcessor('first');
    const throwing = createProcessor('throwing', { onEnd: new Error('end failed') });
    const later = createProcessor('later');
    dynamic.registerSpanProcessor({ id: 'first', processor: first });
    dynamic.registerSpanProcessor({ id: 'throwing', processor: throwing });
    dynamic.registerSpanProcessor({ id: 'later', processor: later });

    const span = trace.getTracer('dynamic-test').startSpan('test-span');
    span.end();
    expect(() => dynamic.onEnd(span as unknown as ReadableSpan)).not.toThrow();

    expect(first.ends).toEqual(['first']);
    expect(throwing.ends).toEqual(['throwing']);
    expect(later.ends).toEqual(['later']);
  });

  it('rejects duplicate processor ids', () => {
    const dynamic = new DynamicSpanProcessor();
    dynamic.registerSpanProcessor({ id: 'langfuse', processor: createProcessor('first') });

    expect(() => dynamic.registerSpanProcessor({ id: 'langfuse', processor: createProcessor('second') })).toThrow(
      "Span processor 'langfuse' is already registered",
    );
  });

  it('unregister cleanup removes and shuts down the processor', async () => {
    const dynamic = new DynamicSpanProcessor();
    const processor = createProcessor('langfuse');
    const unregister = dynamic.registerSpanProcessor({ id: 'langfuse', processor });

    await unregister();
    await dynamic.forceFlush();

    expect(processor.forceFlushMock).toHaveBeenCalledTimes(1);
    expect(processor.shutdownMock).toHaveBeenCalledTimes(1);
    expect(dynamic.registeredProcessorIds()).toEqual([]);
  });

  it('cleanup callback is a no-op after global shutdown', async () => {
    const dynamic = new DynamicSpanProcessor();
    const processor = createProcessor('p');
    const unregister = dynamic.registerSpanProcessor({ id: 'p', processor });
    await dynamic.shutdown();
    await unregister();
    expect(processor.forceFlushMock).toHaveBeenCalledTimes(1);
    expect(processor.shutdownMock).toHaveBeenCalledTimes(1);
  });

  it('shutdown drains all registered processors and rejects later registrations', async () => {
    const dynamic = new DynamicSpanProcessor();
    const processor = createProcessor('langfuse');
    dynamic.registerSpanProcessor({ id: 'langfuse', processor });

    await dynamic.shutdown();

    expect(processor.forceFlushMock).toHaveBeenCalledTimes(1);
    expect(processor.shutdownMock).toHaveBeenCalledTimes(1);
    expect(() => dynamic.registerSpanProcessor({ id: 'after-shutdown', processor: createProcessor('late') })).toThrow(
      'DynamicSpanProcessor has already shut down',
    );
  });
});
