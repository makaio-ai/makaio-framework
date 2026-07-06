import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { LogOrchestratorConfig } from '@makaio/ai-adapters-core';
import type { KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel/extension';
import { LogImportRegistry } from '../log-import-registry.js';
import { LogImportRegistryToken } from '../package.js';
import { createLogImportContributionProcessor } from '../log-import-contribution-processor.js';
import { createMockImporter } from './test-helpers.js';

/**
 * Build a minimal `ExtensionContext` stub for test purposes.
 * @param registry - Optional `LogImportRegistry` to expose via `getService`.
 * @returns Minimal context stub satisfying the `ExtensionContext` contract.
 */
function makeContext(registry?: LogImportRegistry): KernelExtensionContext {
  const bus = createBusInstance();
  return {
    bus,
    identity: { extensionName: 'pkg-log' } as KernelExtensionContext['identity'],
    platform: 'linux',
    homedir: '/home/test',
    makaioHome: '/home/test/.makaio',
    dataDir: '/home/test/.makaio/pkg-log',
    username: 'test',
    machineId: 'machine-1',
    signal: new AbortController().signal,
    tryImport: async () => null,
    getService: ((token) =>
      token.name === LogImportRegistryToken.name ? registry : undefined) as KernelExtensionContext['getService'],
    hasExtension: () => false,
  };
}

/** Minimal LogImporterClass constructor used across tests. */
class StubImporterClass {
  private readonly inner = createMockImporter();
  public constructor(_opts: { adapterId: string; adapterName: string }) {}
  public canHandle = this.inner.canHandle;
  public getLogDirectory = this.inner.getLogDirectory;
  public parseRecord = this.inner.parseRecord;
  public isMakaioManaged = this.inner.isMakaioManaged;
  public extractDiscoveryMetadata = this.inner.extractDiscoveryMetadata;
  public extractSessionContext = this.inner.extractSessionContext;
  public processRecords = this.inner.processRecords;
  public processLogFile = this.inner.processLogFile;
  public serializeState = this.inner.serializeState;
  public deserializeState = this.inner.deserializeState;
}

/** Minimal orchestrator implementation that exposes constructor config. */
class CapturingOrchestrator {
  public constructor(public readonly config: LogOrchestratorConfig) {}
  public isRunning(): boolean {
    return false;
  }
  public async start(): Promise<void> {
    return undefined;
  }
  public stop(): void {
    return undefined;
  }
  public dispose(): void {
    return undefined;
  }
}

/**
 * Build a minimal `MakaioExtension` with a `logImport` contribution.
 * @param name - Extension name.
 * @param configOverrides - Optional overrides applied to the `logImport.config` shape.
 * @returns Minimal extension manifest.
 */
function makePkg(name: string, configOverrides: Record<string, unknown> = {}): KernelMakaioExtension {
  return {
    name,
    displayName: name,
    version: '0.1.0',
    logImport: {
      adapterName: `${name}-adapter`,
      displayName: name,
      config: {
        LogImporterClass: StubImporterClass,
        logFilePattern: '**/*.jsonl',
        ...configOverrides,
      },
    },
  };
}

describe('createLogImportContributionProcessor', () => {
  let registry: LogImportRegistry;

  beforeEach(async () => {
    const bus = createBusInstance();
    registry = new LogImportRegistry({ bus });
    await registry.init();
  });

  afterEach(async () => {
    await registry.destroy();
  });

  it('registers and unregisters a package log importer', async () => {
    const processor = createLogImportContributionProcessor();
    const pkg = makePkg('my-extension', { clientId: 'my-client' });

    await processor.processActivated('my-extension', pkg, makeContext(registry));

    const importers = registry.listImporters();
    expect(importers).toHaveLength(1);
    expect(importers[0]?.id).toBe('package:my-extension');
    expect(importers[0]?.adapterName).toBe('my-extension-adapter');
    expect(importers[0]?.clientId).toBe('my-client');

    await processor.processStopped?.('my-extension');

    expect(registry.listImporters()).toHaveLength(0);
  });

  it('tags adapter packages as source=adapter and extension-only packages as source=extension', async () => {
    const processor = createLogImportContributionProcessor();

    const adapterPkg: KernelMakaioExtension = {
      ...makePkg('adapter-pkg'),
      adapters: [{ manifest: {} as never, definition: {} as never }],
    };
    const extensionPkg = makePkg('extension-pkg');

    await processor.processActivated('adapter-pkg', adapterPkg, makeContext(registry));
    await processor.processActivated('extension-pkg', extensionPkg, makeContext(registry));

    const importers = registry.listImporters();
    const adapterEntry = importers.find((i) => i.id === 'package:adapter-pkg');
    const extensionEntry = importers.find((i) => i.id === 'package:extension-pkg');

    expect(adapterEntry?.source).toBe('adapter');
    expect(extensionEntry?.source).toBe('extension');
  });

  it('rolls back registration when orchestrator factory wiring fails', async () => {
    const processor = createLogImportContributionProcessor();

    // Provide a LogOrchestratorClass so buildOrchestratorFactory returns a
    // factory, then make setOrchestratorFactory throw to simulate a hard
    // wiring failure after registration has already succeeded.
    const pkg = makePkg('broken-extension', {
      LogOrchestratorClass: class {},
    });

    vi.spyOn(registry, 'setOrchestratorFactory').mockImplementationOnce(() => {
      throw new Error('orchestrator wiring failed');
    });

    await expect(processor.processActivated('broken-extension', pkg, makeContext(registry))).rejects.toThrow(
      'orchestrator wiring failed',
    );

    // The registration must have been rolled back.
    expect(registry.listImporters()).toHaveLength(0);
  });

  it('defaults package orchestrator config to enabled when no logImportConfig is declared', async () => {
    const processor = createLogImportContributionProcessor();
    const pkg = makePkg('default-enabled-extension', {
      LogOrchestratorClass: CapturingOrchestrator,
    });

    await processor.processActivated('default-enabled-extension', pkg, makeContext(registry));

    const factory = registry.getImporter('package:default-enabled-extension')?.orchestratorFactory;
    const orchestrator = factory?.('import') as CapturingOrchestrator | undefined;

    expect(orchestrator?.config.enabled).toBe(true);
    expect(orchestrator?.config.adapterId).toBe('package:default-enabled-extension');
    expect(orchestrator?.config.adapterName).toBe('default-enabled-extension-adapter');
  });

  it('does not create package orchestrators when logImportConfig disables import', async () => {
    const processor = createLogImportContributionProcessor();
    const pkg = makePkg('disabled-extension', {
      LogOrchestratorClass: CapturingOrchestrator,
      logImportConfig: { enabled: false },
    });

    await processor.processActivated('disabled-extension', pkg, makeContext(registry));

    const factory = registry.getImporter('package:disabled-extension')?.orchestratorFactory;

    expect(factory?.('import')).toBeNull();
  });

  it('throws a hard composition error when LogImportRegistry is missing', async () => {
    const processor = createLogImportContributionProcessor();
    const pkg = makePkg('any-extension');

    await expect(processor.processActivated('any-extension', pkg, makeContext())).rejects.toThrow(
      'LogImportRegistry is not available',
    );
  });

  it('is a no-op processStopped when no importer was registered for the package', async () => {
    const processor = createLogImportContributionProcessor();

    // No activation — stopped should be silently ignored.
    await expect(processor.processStopped?.('unknown-package')).resolves.toBeUndefined();
  });
});
