/**
 * Configuration schema for the telemetry-langfuse extension.
 * @packageDocumentation
 */

import { z } from 'zod';

/** Export scope for Langfuse span filtering. */
export const TelemetryLangfuseExportScopeSchema = z.enum(['llm-only', 'full-trace']);

/** Langfuse processor export mode. */
export const TelemetryLangfuseExportModeSchema = z.enum(['batched', 'immediate']);

/** Configuration schema consumed by the extension coordinator. */
export const TelemetryLangfuseConfigSchema = z
  .object({
    /** Whether Langfuse export is active. */
    enabled: z.boolean().default(true),
    /** Langfuse public key; falls back to LANGFUSE_PUBLIC_KEY. */
    publicKey: z.string().min(1).optional(),
    /** Langfuse secret key; falls back to LANGFUSE_SECRET_KEY. */
    secretKey: z.string().min(1).optional(),
    /** Langfuse base URL; falls back to LANGFUSE_BASE_URL. */
    baseUrl: z.string().url().optional(),
    /** Langfuse tracing environment; falls back to LANGFUSE_TRACING_ENVIRONMENT. */
    environment: z.string().min(1).optional(),
    /** Langfuse release identifier; falls back to LANGFUSE_RELEASE. */
    release: z.string().min(1).optional(),
    /** Number of spans to batch before flushing. */
    flushAt: z.number().int().positive().optional(),
    /** Flush interval in seconds. */
    flushInterval: z.number().positive().optional(),
    /** Request timeout in seconds. */
    timeout: z.number().positive().optional(),
    /** Span export mode. */
    exportMode: TelemetryLangfuseExportModeSchema.default('batched'),
    /** Filter scope for Langfuse export. */
    exportScope: TelemetryLangfuseExportScopeSchema.default('llm-only'),
  })
  .strict();

/** Parsed telemetry-langfuse config. */
export type TelemetryLangfuseConfig = z.infer<typeof TelemetryLangfuseConfigSchema>;
