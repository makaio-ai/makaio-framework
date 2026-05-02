import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { CapabilitySubjects } from '@makaio/contracts';
import { LogImportSubjects } from '../namespace.js';
import type { LogImportConfig, LogImportOrchestrator, LogImportRegistration } from '@makaio/ai-adapters-core';
import { CapabilityService } from '@makaio/services-core/capability';
import { LogImportRegistry } from '../log-import-registry.js';
import type { LogImporterRegistration } from '../types.js';
import { createMockImporter } from './test-helpers.js';

class TestOrchestrator implements LogImportOrchestrator {
  private running = false;

  public isRunning(): boolean {
    return this.running;
  }

  public async start(): Promise<void> {
    this.running = true;
  }

  public stop(): void {
    this.running = false;
  }

  public dispose(): void {
    this.running = false;
  }
}

class TestProviderImporter {
  private readonly importer = createMockImporter();

  public constructor(_config: { adapterId: string; adapterName: string }) {}

  public canHandle = this.importer.canHandle;
  public getLogDirectory = this.importer.getLogDirectory;
  public parseRecord = this.importer.parseRecord;
  public isMakaioManaged = this.importer.isMakaioManaged;
  public extractDiscoveryMetadata = this.importer.extractDiscoveryMetadata;
  public extractSessionContext = this.importer.extractSessionContext;
  public processRecords = this.importer.processRecords;
  public processLogFile = this.importer.processLogFile;
  public serializeState = this.importer.serializeState;
  public deserializeState = this.importer.deserializeState;
}

const TEST_PROVIDER_REGISTRATION: LogImportRegistration = {
  displayName: 'Provider Importer',
  LogImporterClass: TestProviderImporter,
  LogOrchestratorClass: TestOrchestrator,
  logFilePattern: '**/*.jsonl',
};

describe('LogImportRegistry', () => {
  let registry: LogImportRegistry;
  const cleanups: Array<() => void> = [];

  beforeEach(async () => {
    registry = new LogImportRegistry({ bus: MakaioBus });
    await registry.init();
  });

  afterEach(async () => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
    await registry.destroy();
  });

  it('does not throw when destroy is called on a registry that was never initialized', async () => {
    const freshRegistry = new LogImportRegistry({ bus: MakaioBus });

    await expect(freshRegistry.destroy()).resolves.toBeUndefined();
  });

  describe('register', () => {
    it('should register an importer', async () => {
      const registration: LogImporterRegistration = {
        id: 'test-importer',
        adapterName: 'test-tool',
        displayName: 'Test Importer',
        source: 'adapter',
        importer: createMockImporter(),
        logFilePattern: '**/*.log',
      };

      await registry.register(registration);

      const importers = registry.listImporters();
      expect(importers).toHaveLength(1);
      expect(importers[0].id).toBe('test-importer');
      expect(importers[0].displayName).toBe('Test Importer');
      expect(importers[0].source).toBe('adapter');
    });

    it('should throw error if importer with same ID is already registered', async () => {
      const registration: LogImporterRegistration = {
        id: 'test-importer',
        adapterName: 'test-tool',
        displayName: 'Test Importer',
        source: 'adapter',
        importer: createMockImporter(),
        logFilePattern: '**/*.log',
      };

      await registry.register(registration);

      await expect(registry.register(registration)).rejects.toThrow(
        "Log importer 'test-importer' is already registered",
      );
    });
  });

  describe('unregister', () => {
    it('should unregister an importer', async () => {
      const registration: LogImporterRegistration = {
        id: 'test-importer',
        adapterName: 'test-tool',
        displayName: 'Test Importer',
        source: 'adapter',
        importer: createMockImporter(),
        logFilePattern: '**/*.log',
      };

      await registry.register(registration);
      expect(registry.listImporters()).toHaveLength(1);

      await registry.unregister('test-importer');
      expect(registry.listImporters()).toHaveLength(0);
    });

    it('should throw error if importer is not registered', async () => {
      await expect(registry.unregister('nonexistent')).rejects.toThrow("Log importer 'nonexistent' is not registered");
    });
  });

  describe('listImporters', () => {
    it('should return empty array when no importers are registered', () => {
      const importers = registry.listImporters();
      expect(importers).toEqual([]);
    });

    it('should list all registered importers with status', async () => {
      await registry.register({
        id: 'importer-1',
        adapterName: 'tool-1',
        displayName: 'Importer 1',
        source: 'adapter',
        importer: createMockImporter(),
        logFilePattern: '**/*.log',
      });

      await registry.register({
        id: 'importer-2',
        adapterName: 'tool-2',
        displayName: 'Importer 2',
        source: 'extension',
        importer: createMockImporter(),
        logFilePattern: '**/*.jsonl',
      });

      const importers = registry.listImporters();
      expect(importers).toHaveLength(2);
      expect(importers[0].id).toBe('importer-1');
      expect(importers[0].source).toBe('adapter');
      expect(importers[0].isRunning).toBe(false);
      expect(importers[1].id).toBe('importer-2');
      expect(importers[1].source).toBe('extension');
      expect(importers[1].isRunning).toBe(false);
    });
  });

  describe('bus integration', () => {
    it('should handle listImporters bus request', async () => {
      await registry.register({
        id: 'test-importer',
        adapterName: 'test-tool',
        displayName: 'Test Importer',
        source: 'adapter',
        importer: createMockImporter(),
        logFilePattern: '**/*.log',
      });

      const result = await MakaioBus.request(LogImportSubjects.listImporters, {});

      expect(result.importers).toHaveLength(1);
      expect(result.importers[0].id).toBe('test-importer');
    });
  });

  describe('capability providers', () => {
    it('registers an importer when a log-import capability provider is emitted', async () => {
      await MakaioBus.emit(CapabilitySubjects.register, {
        capabilityId: 'log-import',
        provider: {
          id: 'provider-importer',
          displayName: 'Provider Importer',
          adapterName: 'provider-tool',
          registration: TEST_PROVIDER_REGISTRATION,
        },
      });

      expect(registry.listImporters()).toEqual([
        expect.objectContaining({
          id: 'provider-importer',
          adapterName: 'provider-tool',
          displayName: 'Provider Importer',
          logFilePattern: '**/*.jsonl',
        }),
      ]);
    });

    it('backfills providers registered before registry init when capability service is available', async () => {
      await registry.destroy();

      const capabilityService = new CapabilityService(MakaioBus);
      await capabilityService.init();

      try {
        await MakaioBus.emit(CapabilitySubjects.register, {
          capabilityId: 'log-import',
          provider: {
            id: 'pre-registered-provider',
            displayName: 'Provider Importer',
            adapterName: 'provider-tool',
            registration: TEST_PROVIDER_REGISTRATION,
          },
        });

        const backfilledRegistry = new LogImportRegistry({
          bus: MakaioBus,
          capabilityService,
        });
        await backfilledRegistry.init();

        expect(backfilledRegistry.listImporters()).toEqual([
          expect.objectContaining({
            id: 'pre-registered-provider',
            adapterName: 'provider-tool',
          }),
        ]);

        await backfilledRegistry.destroy();
      } finally {
        capabilityService.destroy();
      }
    });

    it('restores the persisted mode after provider registration', async () => {
      cleanups.push(
        MakaioBus.on(LogImportSubjects.getMode, (ctx) => {
          expect(ctx.payload).toEqual({ adapterName: 'provider-tool' });
          ctx.setResult({ mode: 'import' });
        }),
      );

      await MakaioBus.emit(CapabilitySubjects.register, {
        capabilityId: 'log-import',
        provider: {
          id: 'provider-importer',
          displayName: 'Provider Importer',
          adapterName: 'provider-tool',
          registration: TEST_PROVIDER_REGISTRATION,
          logImportConfig: { enabled: true } satisfies LogImportConfig,
        },
      });

      expect(registry.listImporters()).toEqual([
        expect.objectContaining({
          id: 'provider-importer',
          isRunning: true,
        }),
      ]);
    });

    it('does not register when provider payload is malformed (missing LogImporterClass)', async () => {
      await MakaioBus.emit(CapabilitySubjects.register, {
        capabilityId: 'log-import',
        provider: {
          id: 'bad-provider',
          displayName: 'Bad Provider',
          adapterName: 'bad-tool',
          registration: {
            // LogImporterClass intentionally omitted — malformed payload
            logFilePattern: '**/*.jsonl',
          },
        },
      });

      expect(registry.listImporters()).toHaveLength(0);
    });

    it('registers only one importer when the same provider is emitted twice', async () => {
      const provider = {
        id: 'provider-importer',
        displayName: 'Provider Importer',
        adapterName: 'provider-tool',
        registration: TEST_PROVIDER_REGISTRATION,
      };

      await MakaioBus.emit(CapabilitySubjects.register, { capabilityId: 'log-import', provider });
      await MakaioBus.emit(CapabilitySubjects.register, { capabilityId: 'log-import', provider });

      expect(registry.listImporters()).toHaveLength(1);
    });

    it('does not start an orchestrator when persisted mode is disabled', async () => {
      cleanups.push(
        MakaioBus.on(LogImportSubjects.getMode, (ctx) => {
          ctx.setResult({ mode: 'disabled' });
        }),
      );

      await MakaioBus.emit(CapabilitySubjects.register, {
        capabilityId: 'log-import',
        provider: {
          id: 'provider-importer',
          displayName: 'Provider Importer',
          adapterName: 'provider-tool',
          registration: TEST_PROVIDER_REGISTRATION,
          logImportConfig: { enabled: true } satisfies LogImportConfig,
        },
      });

      expect(registry.listImporters()).toEqual([
        expect.objectContaining({
          id: 'provider-importer',
          isRunning: false,
        }),
      ]);
    });

    it('does not start an orchestrator when adapter log import is disabled', async () => {
      cleanups.push(
        MakaioBus.on(LogImportSubjects.getMode, (ctx) => {
          ctx.setResult({ mode: 'import' });
        }),
      );

      await MakaioBus.emit(CapabilitySubjects.register, {
        capabilityId: 'log-import',
        provider: {
          id: 'provider-importer',
          displayName: 'Provider Importer',
          adapterName: 'provider-tool',
          registration: TEST_PROVIDER_REGISTRATION,
          logImportConfig: { enabled: false } satisfies LogImportConfig,
        },
      });

      expect(registry.listImporters()).toEqual([
        expect.objectContaining({
          id: 'provider-importer',
          isRunning: false,
        }),
      ]);
    });

    it('still registers the provider when no getMode handler exists, without starting an orchestrator', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await MakaioBus.emit(CapabilitySubjects.register, {
          capabilityId: 'log-import',
          provider: {
            id: 'provider-importer',
            displayName: 'Provider Importer',
            adapterName: 'provider-tool',
            registration: TEST_PROVIDER_REGISTRATION,
            logImportConfig: { enabled: true } satisfies LogImportConfig,
          },
        });

        expect(registry.listImporters()).toEqual([
          expect.objectContaining({
            id: 'provider-importer',
            isRunning: false,
          }),
        ]);
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('still registers the provider when getMode handler throws, without starting an orchestrator', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        cleanups.push(
          MakaioBus.on(LogImportSubjects.getMode, () => {
            throw new Error('boom');
          }),
        );

        await MakaioBus.emit(CapabilitySubjects.register, {
          capabilityId: 'log-import',
          provider: {
            id: 'provider-importer',
            displayName: 'Provider Importer',
            adapterName: 'provider-tool',
            registration: TEST_PROVIDER_REGISTRATION,
            logImportConfig: { enabled: true } satisfies LogImportConfig,
          },
        });

        expect(registry.listImporters()).toEqual([
          expect.objectContaining({
            id: 'provider-importer',
            isRunning: false,
          }),
        ]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('switchMode', () => {
    it('stops and does not start a new orchestrator when mode is disabled', async () => {
      cleanups.push(
        MakaioBus.on(LogImportSubjects.getMode, (ctx) => {
          ctx.setResult({ mode: 'import' });
        }),
      );

      await MakaioBus.emit(CapabilitySubjects.register, {
        capabilityId: 'log-import',
        provider: {
          id: 'provider-importer',
          displayName: 'Provider Importer',
          adapterName: 'provider-tool',
          registration: TEST_PROVIDER_REGISTRATION,
          logImportConfig: { enabled: true } satisfies LogImportConfig,
        },
      });

      // Confirm the orchestrator started after restoring 'import' mode
      expect(registry.listImporters()).toEqual([expect.objectContaining({ id: 'provider-importer', isRunning: true })]);

      await registry.switchMode('provider-importer', 'disabled');

      expect(registry.listImporters()).toEqual([
        expect.objectContaining({ id: 'provider-importer', isRunning: false }),
      ]);
    });

    it('restarts the orchestrator when switching from disabled back to import', async () => {
      cleanups.push(
        MakaioBus.on(LogImportSubjects.getMode, (ctx) => {
          ctx.setResult({ mode: 'import' });
        }),
      );

      await MakaioBus.emit(CapabilitySubjects.register, {
        capabilityId: 'log-import',
        provider: {
          id: 'provider-importer',
          displayName: 'Provider Importer',
          adapterName: 'provider-tool',
          registration: TEST_PROVIDER_REGISTRATION,
          logImportConfig: { enabled: true } satisfies LogImportConfig,
        },
      });

      // Step b: initial 'import' mode — orchestrator should be running
      expect(registry.listImporters()).toEqual([expect.objectContaining({ id: 'provider-importer', isRunning: true })]);

      // Step c: switch to 'disabled' — orchestrator should stop
      await registry.switchMode('provider-importer', 'disabled');

      expect(registry.listImporters()).toEqual([
        expect.objectContaining({ id: 'provider-importer', isRunning: false }),
      ]);

      // Step d: switch back to 'import' — orchestrator should restart
      await registry.switchMode('provider-importer', 'import');

      expect(registry.listImporters()).toEqual([expect.objectContaining({ id: 'provider-importer', isRunning: true })]);
    });
  });

  describe('detectImporter', () => {
    it('should detect importer with boolean true', async () => {
      await registry.register({
        id: 'test-importer',
        adapterName: 'test-tool',
        displayName: 'Test Importer',
        source: 'adapter',
        importer: createMockImporter({ canHandle: () => true }),
        logFilePattern: '**/*.log',
      });

      const detected = registry.detectImporter('test sample');
      expect(detected).toBeDefined();
      expect(detected?.id).toBe('test-importer');
    });

    it('should detect importer with highest confidence', async () => {
      await registry.register({
        id: 'low-confidence',
        adapterName: 'tool-1',
        displayName: 'Low Confidence',
        source: 'adapter',
        importer: createMockImporter({ canHandle: () => ({ confidence: 0.3 }) }),
        logFilePattern: '**/*.log',
      });

      await registry.register({
        id: 'high-confidence',
        adapterName: 'tool-2',
        displayName: 'High Confidence',
        source: 'adapter',
        importer: createMockImporter({ canHandle: () => ({ confidence: 0.9 }) }),
        logFilePattern: '**/*.log',
      });

      const detected = registry.detectImporter('test sample');
      expect(detected).toBeDefined();
      expect(detected?.id).toBe('high-confidence');
    });

    it('should return undefined when no importer can handle', async () => {
      await registry.register({
        id: 'test-importer',
        adapterName: 'test-tool',
        displayName: 'Test Importer',
        source: 'adapter',
        importer: createMockImporter({ canHandle: () => false }),
        logFilePattern: '**/*.log',
      });

      const detected = registry.detectImporter('test sample');
      expect(detected).toBeUndefined();
    });
  });

  describe('orchestrator management', () => {
    it('should start and stop a registered orchestrator', async () => {
      await registry.register({
        id: 'test-importer',
        adapterName: 'test-tool',
        displayName: 'Test Importer',
        source: 'adapter',
        importer: createMockImporter(),
        logFilePattern: '**/*.log',
      });

      const orchestrator = new TestOrchestrator();
      await registry.registerOrchestrator('test-importer', orchestrator);

      await registry.startImporter('test-importer');
      expect(orchestrator.isRunning()).toBe(true);

      await registry.stopImporter('test-importer');
      expect(orchestrator.isRunning()).toBe(false);
    });

    it('should register and track orchestrator', async () => {
      const mockOrchestrator = {
        isRunning: vi.fn(() => false),
        start: vi.fn(),
        stop: vi.fn(),
        dispose: vi.fn(),
      } as LogImportOrchestrator;

      await registry.register({
        id: 'test-importer',
        adapterName: 'test-tool',
        displayName: 'Test Importer',
        source: 'adapter',
        importer: createMockImporter(),
        logFilePattern: '**/*.log',
      });

      await registry.registerOrchestrator('test-importer', mockOrchestrator);

      const importers = registry.listImporters();
      expect(importers[0].isRunning).toBe(false);
    });

    it('should throw error if registering orchestrator for unregistered importer', async () => {
      const mockOrchestrator = {
        isRunning: () => false,
        start: vi.fn(),
        stop: vi.fn(),
        dispose: vi.fn(),
      } as LogImportOrchestrator;

      await expect(registry.registerOrchestrator('nonexistent', mockOrchestrator)).rejects.toThrow(
        "Cannot register orchestrator for unregistered importer 'nonexistent'",
      );
    });
  });
});
