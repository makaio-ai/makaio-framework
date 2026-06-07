import { MakaioBus } from '@makaio/bus-core';
import type { SpanProcessorRegistration, TelemetryOtelProcessorRegistry } from '@makaio/extension-telemetry-otel';
import { TelemetryOtelSubjects } from '@makaio/extension-telemetry-otel/contracts';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it, vi } from 'vitest';
import type { TelemetryLangfuseConfig } from '../config.js';
import { TelemetryLangfuseService } from '../telemetry-langfuse-service.js';

/**
 * Build a minimal valid config for the service.
 * @param overrides - Optional partial config to merge over the defaults.
 * @returns A complete {@link TelemetryLangfuseConfig}.
 */
function config(overrides: Partial<TelemetryLangfuseConfig> = {}): TelemetryLangfuseConfig {
  return {
    enabled: true,
    exportScope: 'llm-only',
    exportMode: 'batched',
    ...overrides,
  };
}

/**
 * Minimal in-process processor registry that records registrations and
 * exposes a spy for the unregister path.
 * @returns A fake registry and its state for assertions.
 */
function fakeRegistry(): TelemetryOtelProcessorRegistry & {
  registrations: SpanProcessorRegistration[];
  unregister: ReturnType<typeof vi.fn>;
} {
  const registrations: SpanProcessorRegistration[] = [];
  const unregister = vi.fn(async () => {});
  return {
    registrations,
    unregister,
    registerSpanProcessor: (registration) => {
      registrations.push(registration);
      return unregister;
    },
    registeredProcessorIds: () => registrations.map((r) => r.id),
  };
}

/**
 * Build a no-op span processor for service registration tests.
 * @returns A no-op OTel span processor.
 */
function fakeProcessor(): SpanProcessor {
  return {
    onStart: () => {},
    onEnd: () => {},
    forceFlush: async () => {},
    shutdown: async () => {},
  };
}

describe('TelemetryLangfuseService', () => {
  it('registers a Langfuse processor and Langfuse enricher rules on init', async () => {
    const registry = fakeRegistry();
    const registeredRuleIds: string[] = [];
    const cleanup = MakaioBus.on(TelemetryOtelSubjects.registerEnricherRule, (ctx) => {
      registeredRuleIds.push(ctx.payload.id);
    });
    const service = new TelemetryLangfuseService({
      bus: MakaioBus,
      config: config(),
      telemetryOtel: registry,
    });

    try {
      await service.init();

      expect(registry.registrations).toHaveLength(1);
      expect(registry.registrations[0].id).toBe('telemetry-langfuse');
      expect(registeredRuleIds).toEqual(
        expect.arrayContaining([
          'telemetry-langfuse.gen-ai-llm',
          'telemetry-langfuse.session',
          'telemetry-langfuse.trace-root',
          'telemetry-langfuse.tool',
        ]),
      );
    } finally {
      await service.destroy();
      cleanup();
    }
  });

  it('uses the configured processor factory before registering with telemetry-otel', async () => {
    const registry = fakeRegistry();
    const processor = fakeProcessor();
    const processorFactory = vi.fn(() => processor);
    const service = new TelemetryLangfuseService({
      bus: MakaioBus,
      config: config({ exportMode: 'immediate', exportScope: 'full-trace', publicKey: 'pk-test' }),
      telemetryOtel: registry,
      processorFactory,
    });

    try {
      await service.init();

      expect(processorFactory).toHaveBeenCalledWith(
        expect.objectContaining({
          publicKey: 'pk-test',
          exportMode: 'immediate',
          shouldExportSpan: expect.any(Function),
        }),
      );
      expect(registry.registrations[0].processor).toBe(processor);
    } finally {
      await service.destroy();
    }
  });

  it('unregisters the processor and Langfuse enricher rules during destroy', async () => {
    const registry = fakeRegistry();
    const unregisteredRuleIds: string[] = [];
    const cleanup = MakaioBus.on(TelemetryOtelSubjects.unregisterEnricherRule, (ctx) => {
      unregisteredRuleIds.push(ctx.payload.ruleId);
    });
    const service = new TelemetryLangfuseService({
      bus: MakaioBus,
      config: config(),
      telemetryOtel: registry,
    });

    try {
      await service.init();
      await service.destroy();

      expect(registry.unregister).toHaveBeenCalledTimes(1);
      expect(unregisteredRuleIds).toEqual([
        'telemetry-langfuse.gen-ai-llm',
        'telemetry-langfuse.session',
        'telemetry-langfuse.trace-root',
        'telemetry-langfuse.tool',
      ]);
    } finally {
      cleanup();
    }
  });

  it('rolls back the processor and already-registered enricher rules when rule registration fails', async () => {
    const registry = fakeRegistry();
    const registeredRuleIds: string[] = [];
    const unregisteredRuleIds: string[] = [];
    const failRegistration = MakaioBus.on(TelemetryOtelSubjects.registerEnricherRule, (ctx) => {
      registeredRuleIds.push(ctx.payload.id);
      if (ctx.payload.id === 'telemetry-langfuse.trace-root') {
        throw new Error('rule registration failed');
      }
    });
    const observeUnregistration = MakaioBus.on(TelemetryOtelSubjects.unregisterEnricherRule, (ctx) => {
      unregisteredRuleIds.push(ctx.payload.ruleId);
    });
    const service = new TelemetryLangfuseService({
      bus: MakaioBus,
      config: config(),
      telemetryOtel: registry,
    });

    try {
      await expect(service.init()).rejects.toThrow('rule registration failed');

      expect(registeredRuleIds).toEqual([
        'telemetry-langfuse.gen-ai-llm',
        'telemetry-langfuse.session',
        'telemetry-langfuse.trace-root',
      ]);
      expect(registry.unregister).toHaveBeenCalledTimes(1);
      expect(unregisteredRuleIds).toEqual(['telemetry-langfuse.gen-ai-llm', 'telemetry-langfuse.session']);
    } finally {
      await service.destroy();
      failRegistration();
      observeUnregistration();
    }
  });
});
