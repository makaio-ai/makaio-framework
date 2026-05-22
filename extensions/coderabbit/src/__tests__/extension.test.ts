import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import {
  CapabilitySubjects,
  parseExtensionDescriptor,
  type ProviderRegistration,
  REVIEWER_PROCESSOR_CAPABILITY_ID,
  REVIEW_SOURCE_CAPABILITY_ID,
  type ProviderUnregistration,
  WorkflowBlocksSubjects,
} from '@makaio/contracts';
import { CapabilityService } from '@makaio/services-core/capability';
import { WorkflowBlockRegistry } from '@makaio/services-core';
import { codeRabbitProcessor, coderabbitPackage } from '../index.js';

describe('coderabbitPackage', () => {
  it('declares the review extension dependency', () => {
    expect(coderabbitPackage.dependencies).toContainEqual({
      type: 'extension',
      name: 'review',
      version: '>=0.1.0',
    });
  });

  it('registers and unregisters review capabilities during lifecycle', async () => {
    const bus = createBusInstance();
    const capabilityService = new CapabilityService(bus);
    await capabilityService.init();
    const service = await coderabbitPackage.create!({
      bus,
    } as Parameters<NonNullable<typeof coderabbitPackage.create>>[0]);

    await service.init?.();

    expect(capabilityService.getProviders(REVIEW_SOURCE_CAPABILITY_ID).map((provider) => provider.id)).toEqual([
      'coderabbit',
    ]);
    expect(capabilityService.getProviders(REVIEWER_PROCESSOR_CAPABILITY_ID).map((provider) => provider.id)).toEqual([
      'makaio/coderabbit',
    ]);
    expect(coderabbitPackage.workflowBlocks?.blocks.triggers?.map((block) => block.metadata.name)).toEqual([
      'coderabbit.review-posted',
    ]);
    expect(coderabbitPackage.workflowBlocks?.blocks.steps?.map((block) => block.metadata.name)).toEqual([
      'coderabbit.fetch-findings',
    ]);

    await service.destroy?.();
    expect(capabilityService.getProviders(REVIEW_SOURCE_CAPABILITY_ID)).toEqual([]);
    expect(capabilityService.getProviders(REVIEWER_PROCESSOR_CAPABILITY_ID)).toEqual([]);

    await capabilityService.destroy();
  });

  it('rolls back registered capabilities when processor registration fails during init', async () => {
    const bus = createBusInstance();
    const capabilityService = new CapabilityService(bus);
    await capabilityService.init();
    const failProcessorRegister = bus.on(CapabilitySubjects.register, (ctx) => {
      const registration = ctx.payload as ProviderRegistration;
      if (registration.capabilityId === REVIEWER_PROCESSOR_CAPABILITY_ID) {
        throw new Error('processor register failed');
      }
    });
    const service = await coderabbitPackage.create!({
      bus,
    } as Parameters<NonNullable<typeof coderabbitPackage.create>>[0]);

    await expect(service.init?.()).rejects.toThrow('processor register failed');

    expect(capabilityService.getProviders(REVIEW_SOURCE_CAPABILITY_ID)).toEqual([]);
    expect(capabilityService.getProviders(REVIEWER_PROCESSOR_CAPABILITY_ID)).toEqual([]);

    failProcessorRegister();
    await capabilityService.destroy();
  });

  it('does not remove a pre-existing processor when init processor registration fails', async () => {
    const bus = createBusInstance();
    const capabilityService = new CapabilityService(bus);
    await capabilityService.init();
    await bus.emit(CapabilitySubjects.register, {
      capabilityId: REVIEWER_PROCESSOR_CAPABILITY_ID,
      provider: codeRabbitProcessor,
    });
    const failProcessorRegister = bus.on(CapabilitySubjects.register, (ctx) => {
      const registration = ctx.payload as ProviderRegistration;
      if (registration.capabilityId === REVIEWER_PROCESSOR_CAPABILITY_ID) {
        throw new Error('processor register failed');
      }
    });
    const service = await coderabbitPackage.create!({
      bus,
    } as Parameters<NonNullable<typeof coderabbitPackage.create>>[0]);

    await expect(service.init?.()).rejects.toThrow('processor register failed');

    expect(capabilityService.getProviders(REVIEW_SOURCE_CAPABILITY_ID)).toEqual([]);
    expect(capabilityService.getProviders(REVIEWER_PROCESSOR_CAPABILITY_ID).map((provider) => provider.id)).toEqual([
      'makaio/coderabbit',
    ]);

    failProcessorRegister();
    await capabilityService.destroy();
  });

  it('attempts to unregister source and processor even when one unregister fails', async () => {
    const unregistrations: ProviderUnregistration[] = [];
    const bus = createBusInstance();
    bus.on(CapabilitySubjects.unregister, (ctx) => {
      const unregistration = ctx.payload as ProviderUnregistration;
      unregistrations.push(unregistration);
      if (unregistration.capabilityId === REVIEWER_PROCESSOR_CAPABILITY_ID) {
        throw new Error('processor unregister failed');
      }
    });
    const service = await coderabbitPackage.create!({
      bus,
    } as Parameters<NonNullable<typeof coderabbitPackage.create>>[0]);

    await expect(service.destroy?.()).rejects.toThrow('processor unregister failed');

    expect(unregistrations).toEqual([
      {
        capabilityId: REVIEWER_PROCESSOR_CAPABILITY_ID,
        providerId: 'makaio/coderabbit',
      },
      {
        capabilityId: REVIEW_SOURCE_CAPABILITY_ID,
        providerId: 'coderabbit',
      },
    ]);
  });

  it('registers real workflow block schemas through the registry catalog', async () => {
    const bus = createBusInstance();
    const registry = new WorkflowBlockRegistry(bus);
    await registry.init();

    await registry.register(coderabbitPackage.name, coderabbitPackage.workflowBlocks!.blocks);

    const listed = await bus.request(WorkflowBlocksSubjects.list, {});

    expect(listed.triggers).toHaveLength(1);
    expect(listed.triggers[0]?.metadata).toEqual({
      name: 'coderabbit.review-posted',
      label: 'CodeRabbit Review Posted',
      description: 'Fires when CodeRabbit submits a review on a PR.',
      categories: ['review', 'vcs'],
      extensionName: 'coderabbit',
    });
    expect(listed.triggers[0]?.configSchema).toMatchObject({
      properties: {
        minSeverity: {
          default: 'minor',
          enum: ['critical', 'major', 'minor', 'nitpick'],
        },
        repository: {
          type: 'string',
        },
      },
    });
    expect(listed.triggers[0]?.outputSchema).toMatchObject({
      properties: {
        findingCount: { type: 'number' },
        severityCounts: {
          properties: {
            critical: { type: 'number' },
            major: { type: 'number' },
            minor: { type: 'number' },
            nitpick: { type: 'number' },
          },
        },
      },
    });

    expect(listed.steps).toHaveLength(1);
    expect(listed.steps[0]?.metadata).toMatchObject({
      name: 'coderabbit.fetch-findings',
      extensionName: 'coderabbit',
      categories: ['review'],
    });
    expect(listed.steps[0]?.configSchema).toMatchObject({
      properties: {
        includeResolved: {
          default: false,
          type: 'boolean',
        },
      },
    });
    expect(listed.steps[0]?.inputSchema).toMatchObject({
      properties: {
        target: {
          properties: {
            repository: { type: 'string' },
          },
        },
      },
    });
    expect(listed.steps[0]?.outputSchema).toMatchObject({
      properties: {
        findings: {
          items: {
            properties: {
              id: { type: 'string' },
              severity: { enum: ['critical', 'major', 'minor', 'nitpick'] },
              message: { type: 'string' },
            },
          },
        },
      },
    });

    await registry.destroy();
  });
});

describe('CodeRabbit extension distribution metadata', () => {
  it('uses the extension package namespace while preserving the runtime extension name', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as {
      readonly name: string;
    };
    const descriptor = parseExtensionDescriptor(
      JSON.parse(readFileSync(new URL('../../descriptor.json', import.meta.url), 'utf-8')),
    );

    expect(packageJson.name).toBe('@makaio/extension-coderabbit');
    expect(descriptor.name).toBe('coderabbit');
    expect(descriptor.entrypoints?.server).toBe('index');
    expect(descriptor.execution).toBe('embedded');
    expect(descriptor.dependencies).toContainEqual({
      type: 'extension',
      name: 'review',
      version: '>=0.1.0',
    });
  });

  it('has a descriptor-discoverable review dependency', () => {
    const descriptor = parseExtensionDescriptor(
      JSON.parse(readFileSync(new URL('../../../review/descriptor.json', import.meta.url), 'utf-8')),
    );

    expect(descriptor).toMatchObject({
      name: 'review',
      displayName: 'Review Findings',
      entrypoints: { server: 'index' },
      execution: 'embedded',
      storage: {
        migrations: 'drizzle',
        migrationSourceId: 'extensions/review/drizzle',
      },
    });
    expect(descriptor.contributions).toMatchObject({
      create: true,
      tools: true,
    });
  });
});
