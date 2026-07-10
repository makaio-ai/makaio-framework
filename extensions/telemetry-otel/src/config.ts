/**
 * Configuration schema for the telemetry-otel extension.
 *
 * Parsed from the extension's stored config at boot. Optional exporter fields
 * are left undefined so the OTel SDK can honor its standard environment
 * variables.
 * @packageDocumentation
 */

import { z } from 'zod';

/**
 * Zod schema describing the telemetry-otel extension configuration.
 *
 * Consumed by {@link MakaioExtension.configSchema} and validated at boot.
 */
export const TelemetryOtelConfigSchema = z
  .object({
    /** Whether the OTel exporter is active. Defaults to `true`. */
    enabled: z.boolean().default(true),
    /**
     * OTLP HTTP endpoint for trace export.
     *
     * When omitted, the OTLP exporter reads standard OTel environment
     * variables such as `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and
     * `OTEL_EXPORTER_OTLP_ENDPOINT`.
     */
    otlpEndpoint: z.string().url().optional(),
    /**
     * `service.name` resource attribute attached to every span.
     * Defaults to `'makaio'`.
     */
    serviceName: z.string().min(1).default('makaio'),
    /**
     * `service.version` resource attribute. Optional; omitted when absent.
     */
    serviceVersion: z.string().min(1).optional(),
    /**
     * Batch span processor tuning. Defaults match the OTel SDK defaults for
     * low-traffic local development.
     */
    batchConfig: z
      .object({
        /** Maximum number of spans in a single export batch. */
        maxExportBatchSize: z.number().int().positive().default(512),
        /** Delay in ms between automatic batch flushes. */
        scheduledDelayMs: z.number().int().positive().default(5000),
        /** Maximum wait in ms for a single export RPC to complete. */
        exportTimeoutMs: z.number().int().positive().default(30000),
      })
      .strict()
      .prefault({}),
    /**
     * Maximum number of concurrently open execution spans held in the pending
     * map before the oldest is evicted. Guards against memory growth on
     * long-running or leaked executions.
     */
    maxOpenExecutions: z.number().int().positive().default(1000),
    /**
     * Time in ms after which execution-owned sessionless agent usage/tool
     * events are promoted to orphan spans, and unlinked sessioned events are
     * exported as standalone trace segments. Active executions are never ended
     * by this timeout.
     * Set to `0` to retain unlinked events until a frame link or shutdown.
     */
    orphanTimeoutMs: z.number().int().nonnegative().default(30000),
  })
  .strict();

/** Inferred TypeScript type for the telemetry-otel extension configuration. */
export type TelemetryOtelConfig = z.infer<typeof TelemetryOtelConfigSchema>;
