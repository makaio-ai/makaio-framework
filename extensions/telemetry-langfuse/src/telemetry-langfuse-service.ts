/**
 * Service wiring for the telemetry-langfuse extension.
 * @packageDocumentation
 */

import { LangfuseSpanProcessor, type LangfuseSpanProcessorParams } from '@langfuse/otel';
import type { IMakaioBus } from '@makaio/bus-core';
import { registerSpanEnricherRule, type TelemetryOtelProcessorRegistry } from '@makaio/extension-telemetry-otel';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { BaseService } from '@makaio/service-base';
import type { TelemetryLangfuseConfig } from './config.js';
import { createLangfuseEnricherRules } from './enrichers/langfuse-rules.js';
import { createLangfuseShouldExportSpan } from './filters.js';

/**
 * Factory for constructing the Langfuse span processor.
 * @param params - Langfuse processor construction parameters.
 * @returns OTel span processor registered with telemetry-otel.
 */
export type LangfuseProcessorFactory = (params: LangfuseSpanProcessorParams) => SpanProcessor;

/** Construction options for {@link TelemetryLangfuseService}. */
export interface TelemetryLangfuseServiceOptions {
  /** Bus used for enricher rule registration. */
  readonly bus: IMakaioBus;
  /** Parsed extension config. */
  readonly config: TelemetryLangfuseConfig;
  /** Local telemetry-otel service registry. */
  readonly telemetryOtel: TelemetryOtelProcessorRegistry;
  /** Optional factory for replacing the network-capable Langfuse processor in tests. */
  readonly processorFactory?: LangfuseProcessorFactory;
}

/**
 * Registers the Langfuse span processor and enricher rules with the
 * telemetry-otel extension.
 *
 * On init, creates a {@link LangfuseSpanProcessor} from the parsed config,
 * registers it with the {@link TelemetryOtelProcessorRegistry}, and emits
 * all Langfuse enricher rules onto the bus so the
 * {@link SpanEnricherRuleRegistry} picks them up.
 *
 * All registrations are torn down on destroy via the cleanup queue inherited
 * from {@link BaseService}.
 */
export class TelemetryLangfuseService extends BaseService {
  private readonly config: TelemetryLangfuseConfig;
  private readonly processorFactory: LangfuseProcessorFactory;
  private readonly telemetryOtel: TelemetryOtelProcessorRegistry;

  /**
   * @param options - Service construction options.
   */
  public constructor(options: TelemetryLangfuseServiceOptions) {
    super(options.bus);
    this.config = options.config;
    this.processorFactory = options.processorFactory ?? ((params) => new LangfuseSpanProcessor(params));
    this.telemetryOtel = options.telemetryOtel;
  }

  /**
   * Register the Langfuse span processor and all enricher rules.
   *
   * Processor and enricher rule cleanups are enqueued as each registration
   * succeeds so `destroy()` and init rollback both release partial startup.
   */
  protected async onInit(): Promise<void> {
    const processor = this.processorFactory({
      publicKey: this.config.publicKey,
      secretKey: this.config.secretKey,
      baseUrl: this.config.baseUrl,
      environment: this.config.environment,
      release: this.config.release,
      flushAt: this.config.flushAt,
      flushInterval: this.config.flushInterval,
      timeout: this.config.timeout,
      exportMode: this.config.exportMode,
      shouldExportSpan: createLangfuseShouldExportSpan(this.config.exportScope),
    });

    const unregisterProcessor = this.telemetryOtel.registerSpanProcessor({
      id: 'telemetry-langfuse',
      processor,
    });
    this.addCleanup(unregisterProcessor);

    for (const rule of createLangfuseEnricherRules()) {
      const cleanup = await registerSpanEnricherRule(this.bus, rule);
      this.addCleanup(cleanup);
    }
  }
}
