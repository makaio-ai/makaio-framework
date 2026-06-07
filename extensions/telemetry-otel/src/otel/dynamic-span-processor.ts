/**
 * Runtime-mutable OpenTelemetry span processor multiplexer.
 *
 * `BasicTracerProvider` accepts span processors only at construction time.
 * This processor is installed once and delegates future span lifecycle calls to
 * child processors registered by dependent extensions.
 * @packageDocumentation
 */

import { diag, type Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';

/** Processor registration payload for local in-process telemetry consumers. */
export interface SpanProcessorRegistration {
  /** Stable unique registration id. */
  readonly id: string;
  /** OTel processor instance to receive future span lifecycle calls. */
  readonly processor: SpanProcessor;
}

/** Public local registry exposed by `telemetry-otel` through an ExtensionToken. */
export interface TelemetryOtelProcessorRegistry {
  /**
   * Register a processor for future spans.
   * @param registration - Registration id and processor.
   * @returns Cleanup callback that flushes, shuts down, and removes the processor.
   */
  registerSpanProcessor(registration: SpanProcessorRegistration): () => Promise<void>;
  /**
   * List registered processor ids for diagnostics and tests.
   * @returns Registered ids in insertion order.
   */
  registeredProcessorIds(): readonly string[];
}

/**
 * Composite OTel span processor with runtime registration.
 *
 * Installed once into `BasicTracerProvider` at construction time and then
 * accepts child processor registrations at runtime. Span lifecycle events are
 * forwarded to all currently registered child processors.
 */
export class DynamicSpanProcessor implements SpanProcessor, TelemetryOtelProcessorRegistry {
  private readonly processors = new Map<string, SpanProcessor>();
  private shutdownComplete = false;

  /**
   * Register a child processor.
   *
   * Throws if the registry has already been shut down or if a processor with
   * the same id is already registered.
   * @param registration - Registration id and processor.
   * @returns Cleanup callback that flushes, shuts down, and removes this processor.
   * If the registry has already shut down when the cleanup is called, the cleanup is a no-op.
   */
  public registerSpanProcessor(registration: SpanProcessorRegistration): () => Promise<void> {
    if (this.shutdownComplete) {
      throw new Error('DynamicSpanProcessor has already shut down');
    }
    if (this.processors.has(registration.id)) {
      throw new Error(`Span processor '${registration.id}' is already registered`);
    }

    this.processors.set(registration.id, registration.processor);

    return async () => {
      const processor = this.processors.get(registration.id);
      if (processor === undefined) {
        return;
      }
      this.processors.delete(registration.id);
      await processor.forceFlush();
      await processor.shutdown();
    };
  }

  /**
   * List registered processor ids for diagnostics and tests.
   * @returns Registered ids in insertion order.
   */
  public registeredProcessorIds(): readonly string[] {
    return [...this.processors.keys()];
  }

  /**
   * Forward span start to all registered child processors.
   * @param span - The span that just started.
   * @param parentContext - The parent context for this span.
   */
  public onStart(span: Span, parentContext: Context): void {
    for (const processor of this.processors.values()) {
      try {
        processor.onStart(span, parentContext);
      } catch (error) {
        diag.error('DynamicSpanProcessor child processor onStart failed', error);
      }
    }
  }

  /**
   * Forward span end to all registered child processors.
   * @param span - The span that just ended.
   */
  public onEnd(span: ReadableSpan): void {
    for (const processor of this.processors.values()) {
      try {
        processor.onEnd(span);
      } catch (error) {
        diag.error('DynamicSpanProcessor child processor onEnd failed', error);
      }
    }
  }

  /**
   * Force-flush all registered child processors.
   * @returns Promise resolved when all processors have flushed.
   */
  public async forceFlush(): Promise<void> {
    await Promise.all([...this.processors.values()].map((processor) => processor.forceFlush()));
  }

  /**
   * Flush and shut down all registered child processors, then block further
   * registrations.
   *
   * Calling `shutdown` a second time is a no-op.
   */
  public async shutdown(): Promise<void> {
    if (this.shutdownComplete) {
      return;
    }
    this.shutdownComplete = true;
    const processors = [...this.processors.values()];
    this.processors.clear();
    await Promise.all(
      processors.map(async (processor) => {
        await processor.forceFlush();
        await processor.shutdown();
      }),
    );
  }
}
