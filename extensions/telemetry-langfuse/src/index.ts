/**
 * telemetry-langfuse extension entry point.
 *
 * Exports the executable extension manifest consumed by the
 * `ExtensionCoordinator` at boot, along with the public config surface.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioNodeExtension } from '@makaio/contracts/extension';
import { dep } from '@makaio/contracts/extension';
import { TelemetryOtelServiceToken, type TelemetryOtelProcessorRegistry } from '@makaio/extension-telemetry-otel';
import { ServiceSkipError } from '@makaio/kernel';
import { TelemetryLangfuseConfigSchema } from './config.js';
import { TelemetryLangfuseService } from './telemetry-langfuse-service.js';

/**
 * Check whether a dependency service exposes the telemetry-otel processor registry.
 * @param service - Service returned by the extension coordinator.
 * @returns `true` when the service has the processor registry API.
 */
function isTelemetryOtelProcessorRegistry(service: unknown): service is TelemetryOtelProcessorRegistry {
  if (typeof service !== 'object' || service === null) {
    return false;
  }
  const candidate = service as Partial<Record<keyof TelemetryOtelProcessorRegistry, unknown>>;
  return (
    typeof candidate.registerSpanProcessor === 'function' && typeof candidate.registeredProcessorIds === 'function'
  );
}

/**
 * Executable extension manifest for the Langfuse telemetry exporter extension.
 *
 * Declares a dependency on `telemetry-otel` so the `ExtensionCoordinator`
 * ensures the OTel provider is running before this extension is activated.
 * The `create` factory parses the stored config, returns an empty service
 * object when `enabled` is `false`, and throws {@link ServiceSkipError} when
 * the `telemetry-otel` processor registry is unavailable.
 */
export const telemetryLangfusePackage: MakaioNodeExtension<IMakaioBus> = {
  name: 'telemetry-langfuse',
  displayName: 'Langfuse Telemetry Exporter',
  version: '0.1.0',
  surface: 'headless',
  dependencies: [dep('telemetry-otel')],
  configSchema: TelemetryLangfuseConfigSchema,
  create: (ctx) => {
    const config = TelemetryLangfuseConfigSchema.parse(ctx.config ?? {});
    if (!config.enabled) {
      return {};
    }
    const telemetryOtel = ctx.getService(TelemetryOtelServiceToken);
    if (telemetryOtel === undefined) {
      throw new ServiceSkipError('telemetry-otel service is not active');
    }
    if (!isTelemetryOtelProcessorRegistry(telemetryOtel)) {
      throw new ServiceSkipError('telemetry-otel processor registry is not active');
    }
    return new TelemetryLangfuseService({
      bus: ctx.bus,
      config,
      telemetryOtel,
    });
  },
};

export default telemetryLangfusePackage;

export { TelemetryLangfuseConfigSchema } from './config.js';
export type { TelemetryLangfuseConfig } from './config.js';
export { createLangfuseEnricherRules } from './enrichers/langfuse-rules.js';
export { createLangfuseShouldExportSpan } from './filters.js';
export { TelemetryLangfuseService } from './telemetry-langfuse-service.js';
export type { TelemetryLangfuseServiceOptions } from './telemetry-langfuse-service.js';
