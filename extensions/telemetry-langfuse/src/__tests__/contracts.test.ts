import { readFileSync } from 'node:fs';
import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import type { ExtensionService, ExtensionToken, NodeExtensionContext } from '@makaio/contracts/extension';
import { describe, expect, it } from 'vitest';
import { dep, parseExtensionDescriptor } from '@makaio/contracts';
import { TelemetryOtelServiceToken } from '@makaio/extension-telemetry-otel';
import { ServiceSkipError } from '@makaio/kernel';
import { TelemetryLangfuseConfigSchema } from '../config.js';
import { telemetryLangfusePackage } from '../index.js';

/**
 * Build the minimal node extension context needed by the package factory.
 * @param telemetryOtelService - Service returned for the telemetry-otel token.
 * @returns Runtime context for factory contract tests.
 */
function createFactoryContext(telemetryOtelService: unknown): NodeExtensionContext<IMakaioBus> {
  return {
    bus: MakaioBus,
    identity: { extensionName: 'telemetry-langfuse' } as NodeExtensionContext<IMakaioBus>['identity'],
    dataDir: '/tmp/telemetry-langfuse-test',
    machineId: 'test-machine',
    config: { enabled: true },
    getService: <T>(token: ExtensionToken<T>): T | undefined =>
      token.name === TelemetryOtelServiceToken.name ? (telemetryOtelService as T) : undefined,
    tryImport: async () => null,
    signal: new AbortController().signal,
    hasExtension: (name) => name === 'telemetry-otel',
    platform: process.platform,
    homedir: '/tmp',
    makaioHome: '/tmp/.makaio',
    username: 'test',
  };
}

/**
 * Invoke the Langfuse service factory.
 * @param ctx - Factory context.
 * @returns Created extension service.
 */
function createService(ctx: NodeExtensionContext<IMakaioBus>): ExtensionService | Promise<ExtensionService> {
  const create = telemetryLangfusePackage.create;
  if (create === undefined) {
    throw new Error('telemetry-langfuse package does not expose a service factory');
  }
  return create(ctx);
}

describe('telemetry-langfuse contracts', () => {
  it('declares telemetry-otel as a required dependency', () => {
    expect(telemetryLangfusePackage.dependencies).toEqual([dep('telemetry-otel')]);
  });

  it('points descriptor discovery at the index server entrypoint', () => {
    const descriptor = parseExtensionDescriptor(
      JSON.parse(readFileSync(new URL('../../descriptor.json', import.meta.url), 'utf-8')),
    );

    expect(descriptor.name).toBe('telemetry-langfuse');
    expect(descriptor.entrypoints?.server).toBe('index');
    expect(descriptor.execution).toBe('embedded');
    expect(descriptor.dependencies).toEqual([dep('telemetry-otel')]);
  });

  it('parses config defaults', () => {
    expect(TelemetryLangfuseConfigSchema.parse({})).toMatchObject({
      enabled: true,
      exportScope: 'llm-only',
      exportMode: 'batched',
    });
  });

  it('skips when telemetry-otel exposes only a no-op service object', () => {
    const createWithNoopTelemetryOtel = () => createService(createFactoryContext({}));

    expect(createWithNoopTelemetryOtel).toThrow(ServiceSkipError);
    expect(createWithNoopTelemetryOtel).toThrow('telemetry-otel processor registry is not active');
  });
});
