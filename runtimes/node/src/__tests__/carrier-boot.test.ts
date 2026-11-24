import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { inspect } from 'node:util';
import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import {
  ArtifactSubjects,
  defineArtifactKind,
  dep,
  type ArtifactKindRegistration,
  type ExtensionWarning,
} from '@makaio/contracts';
import { ExtensionSubjects, NoTransportProvider, type KernelMakaioExtension } from '@makaio/kernel';
import { BaseService } from '@makaio/service-base';
import { ArtifactSchemaRegistryToken, type ArtifactSchemaRegistry } from '@makaio/services-core';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { bootMakaioRuntimeCore, type MakaioRuntime } from '../boot.js';
import { ExplicitDescriptorDiscovery } from '../extension-discovery.js';

const EXTENSION_NAME = 'carrier-boot-fixture';
const KIND = defineArtifactKind({
  kind: 'carrier-boot-note',
  description: 'Note contributed during the carrier lifecycle test.',
  schemaVersion: 1,
  dataSchema: z.object({ title: z.string() }),
  category: 'record',
  titlePath: 'title',
});
const WARNING: ExtensionWarning = {
  severity: 'info',
  title: 'Carrier health fixture',
  message: 'The extension could query the artifact registry on its own bus.',
};
const transport = new NoTransportProvider();

class CarrierHealthService extends BaseService {
  public constructor(bus: IMakaioBus) {
    super(bus);
  }

  protected override onInit(): void {}

  public async checkHealth(): Promise<ExtensionWarning[]> {
    await this.bus.request(this.bus.own('start'), ArtifactSubjects.kind.list, { kind: KIND.kind });
    return [WARNING];
  }
}

it('starts and stops cross-carrier contributions and checks extension health', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'makaio-carrier-boot-'));
  const rejected: unknown[] = [];
  const recordRejection = (reason: unknown): void => {
    rejected.push(reason);
  };
  const errors = vi.spyOn(console, 'error');
  const warnings = vi.spyOn(console, 'warn');
  const { kind, schemaVersion } = KIND;
  const changed: Array<ArtifactKindRegistration | undefined> = [];
  let registry: ArtifactSchemaRegistry | undefined;
  let runtime: MakaioRuntime | undefined;
  process.on('unhandledRejection', recordRejection);
  const unsubscribe = MakaioBus.on(ArtifactSubjects.kind.changed, ({ payload }) => {
    if (payload.kind === kind) changed.push(registry?.getKind(kind, schemaVersion));
  });

  try {
    for (const key of ['MAKAIO_SKIP_EXTENSIONS', 'MAKAIO_DATABASE_URL', 'MAKAIO_DATABASE_PATH']) {
      vi.stubEnv(key, undefined);
    }
    const pkg: KernelMakaioExtension = {
      name: EXTENSION_NAME,
      displayName: 'Carrier Boot Fixture',
      version: '1.0.0',
      dependencies: [dep(ArtifactSchemaRegistryToken.name)],
      artifactKinds: { kinds: [KIND] },
      create: (ctx) => {
        registry = ctx.getService(ArtifactSchemaRegistryToken);
        return new CarrierHealthService(ctx.bus);
      },
    };

    runtime = await bootMakaioRuntimeCore(transport, 0, '127.0.0.1', {
      discovery: new ExplicitDescriptorDiscovery([
        {
          descriptor: {
            name: pkg.name,
            displayName: pkg.displayName,
            version: pkg.version,
            makaio: { framework: '>=1.0.0' },
            entrypoints: { server: true },
          },
          extensionPath: home,
          source: 'local',
          preloadedModule: { default: pkg },
        },
      ]),
      frameworkVersion: '3.0.0',
      hostCapabilities: ['node'],
      makaioHome: home,
    });

    expect(registry?.getKind(kind, schemaVersion)).toEqual(KIND.toRegistration());
    await expect(
      runtime.bus.request(runtime.bus.own('observer'), ExtensionSubjects.warnings.list, { extensionName: pkg.name }),
    ).resolves.toEqual({ entries: [{ extensionName: pkg.name, warnings: [WARNING] }] });

    await runtime.shutdown();
    runtime = undefined;
    await setImmediate();

    const foreignErrors = [...rejected, ...errors.mock.calls.flat(), ...warnings.mock.calls.flat()].filter((value) =>
      /ForeignOwnContextError|Own call context of/.test(inspect(value)),
    );
    expect(foreignErrors).toEqual([]);
    expect(registry?.getKind(kind, schemaVersion)).toBeUndefined();
    expect(changed).toEqual([KIND.toRegistration(), undefined]);
  } finally {
    try {
      await runtime?.shutdown();
    } finally {
      unsubscribe();
      process.off('unhandledRejection', recordRejection);
      errors.mockRestore();
      warnings.mockRestore();
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  }
});
