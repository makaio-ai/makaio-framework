/**
 * telemetry-otel extension entry point.
 *
 * Exports the executable extension manifest consumed by the
 * `ExtensionCoordinator` at boot, along with the full public contract surface.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioNodeExtension } from '@makaio/contracts/extension';
import { extensionToken } from '@makaio/contracts/extension';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { TelemetryOtelNamespace } from './contracts/namespace.js';
import { TelemetryOtelConfigSchema } from './config.js';
import type { TelemetryOtelConfig } from './config.js';
import { OtelSpanEmitter } from './otel/otel-span-emitter.js';
import { DynamicSpanProcessor } from './otel/dynamic-span-processor.js';
import type { TelemetryOtelProcessorRegistry } from './otel/dynamic-span-processor.js';
import { TelemetryOtelService } from './telemetry-otel-service.js';

/**
 * Extension token for retrieving the processor registry from the runtime
 * extension coordinator.
 *
 * Dependent extensions use this token to register local OTel span processors
 * without a direct import dependency on the service instance.
 */
export const TelemetryOtelServiceToken = extensionToken<TelemetryOtelProcessorRegistry>('telemetry-otel');

/**
 * Build a fully wired {@link TelemetryOtelService} from a parsed config.
 *
 * Sets up the OTel SDK resource, exporter, and batch processor, then wires
 * them into an {@link OtelSpanEmitter} and a {@link TelemetryOtelService}.
 *
 * `provider.register()` is intentionally **not** called: the provider is used
 * as a self-contained tracer factory only. Registering it globally would
 * interfere with other OTel users in the same process.
 * @param bus - Runtime bus used for handler registration.
 * @param config - Parsed telemetry-otel configuration.
 * @returns Constructed (but not yet initialized) service.
 */
function createTelemetryOtelService(bus: IMakaioBus, config: TelemetryOtelConfig): TelemetryOtelService {
  const resourceAttributes: Record<string, string> = {
    [ATTR_SERVICE_NAME]: config.serviceName,
  };
  if (config.serviceVersion !== undefined) {
    resourceAttributes[ATTR_SERVICE_VERSION] = config.serviceVersion;
  }

  const resource = resourceFromAttributes(resourceAttributes);

  const exporter = new OTLPTraceExporter(
    config.otlpEndpoint !== undefined
      ? {
          url: config.otlpEndpoint,
        }
      : undefined,
  );

  const batchProcessor = new BatchSpanProcessor(exporter, {
    maxExportBatchSize: config.batchConfig.maxExportBatchSize,
    scheduledDelayMillis: config.batchConfig.scheduledDelayMs,
    exportTimeoutMillis: config.batchConfig.exportTimeoutMs,
  });

  const dynamicProcessor = new DynamicSpanProcessor();

  const provider = new BasicTracerProvider({
    resource,
    spanProcessors: [batchProcessor, dynamicProcessor],
  });

  const tracer = provider.getTracer(config.serviceName);
  const emitter = new OtelSpanEmitter({ tracer, provider });

  return new TelemetryOtelService({ bus, config, emitter, processorRegistry: dynamicProcessor });
}

/**
 * Executable extension manifest for the OpenTelemetry exporter extension.
 *
 * Declares the bus namespace so `ExtensionCoordinator` registers subjects
 * before the service factory is called. The `create` factory parses the
 * stored config and constructs the real service when `enabled` is `true`.
 */
export const telemetryOtelPackage: MakaioNodeExtension<IMakaioBus> = {
  name: 'telemetry-otel',
  displayName: 'OpenTelemetry Exporter',
  version: '0.1.0',
  surface: 'headless',
  namespaces: [TelemetryOtelNamespace],
  configSchema: TelemetryOtelConfigSchema,
  create: (ctx) => {
    const config = TelemetryOtelConfigSchema.parse(ctx.config ?? {});
    if (!config.enabled) {
      // Return a no-op service so the coordinator does not need to handle
      // undefined. The extension is structurally present but inactive.
      return {};
    }
    return createTelemetryOtelService(ctx.bus, config);
  },
};

export default telemetryOtelPackage;

// Service
export { TelemetryOtelService } from './telemetry-otel-service.js';
export type { TelemetryOtelServiceOptions, TelemetryOtelSpanEmitter } from './telemetry-otel-service.js';

// Config
export type { TelemetryOtelConfig } from './config.js';
export { TelemetryOtelConfigSchema } from './config.js';

// Contracts — types
export type {
  EnrichSpanResponse,
  SpanDraft,
  SpanDraftKind,
  SpanDraftStatus,
  SpanEnricherAction,
  SpanEnricherRule,
  SpanEventDraft,
  SpanLinkDraft,
} from './contracts/types.js';

// Contracts — schemas
export {
  EnrichSpanResponseSchema,
  SpanDraftKindSchema,
  SpanDraftSchema,
  SpanDraftStatusSchema,
  SpanEnricherActionSchema,
  SpanEnricherRuleSchema,
  SpanEventDraftSchema,
  SpanLinkDraftSchema,
} from './contracts/schemas.js';

// Contracts — namespace + subjects
export { TelemetryOtelNamespace, TelemetryOtelSchemas, TelemetryOtelSubjects } from './contracts/namespace.js';

// Contracts — registration helper
export { registerSpanEnricherRule } from './contracts/register.js';

// OTel processor registry
export { DynamicSpanProcessor } from './otel/dynamic-span-processor.js';
export type {
  SpanProcessorRegistration,
  TelemetryOtelProcessorRegistry,
} from './otel/dynamic-span-processor.js';
