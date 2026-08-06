import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import {
  CapabilitySubjects,
  createAutomationTriggerDescriptor,
  parseExtensionDescriptor,
  type AutomationTriggerType,
  type ProviderRegistration,
  REVIEWER_PROCESSOR_CAPABILITY_ID,
  REVIEW_SOURCE_CAPABILITY_ID,
  type ProviderUnregistration,
} from '@makaio/contracts';
import { CapabilityService } from '@makaio/services-core/capability';
import { codeRabbitProcessor, coderabbitPackage } from '../index.js';

/**
 * Invokes the package's automation trigger contribution with a bus-only context.
 * @param bus - Bus handed to the contribution.
 * @returns The contributed registry-boundary trigger types.
 */
async function contributeTriggers(bus: IMakaioBus): Promise<readonly AutomationTriggerType[]> {
  const contribution = coderabbitPackage.automationTriggers;
  if (!contribution) throw new Error('coderabbitPackage must contribute automation triggers');
  type TriggerContext = Parameters<typeof contribution.createAutomationTriggers>[0];
  return contribution.createAutomationTriggers({ bus } as TriggerContext);
}

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

  it('contributes an executable review-posted trigger whose parameters carry no severity threshold', async () => {
    const bus = createBusInstance();

    const triggers = await contributeTriggers(bus);

    expect(triggers.map((trigger) => trigger.kind)).toEqual(['coderabbit.review-posted']);

    const descriptor = createAutomationTriggerDescriptor(triggers[0]!);
    expect(descriptor.label).toBe('CodeRabbit review posted');
    expect(descriptor.categories).toEqual(['Code review']);
    expect(descriptor.parameterSchema).toMatchObject({
      type: 'object',
      properties: { repository: { type: 'string' } },
      required: ['repository'],
    });
    expect(Object.keys(descriptor.parameterSchema.properties ?? {})).not.toContain('minSeverity');
    expect(JSON.stringify(descriptor)).not.toContain('minSeverity');
    expect(triggers[0]!.activate).toBeTypeOf('function');
  });

  it('declares no workflow block collection now that start conditions are triggers', () => {
    expect(coderabbitPackage.workflowBlocks).toBeUndefined();
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
