/**
 * OpenCode-specific integration test helpers.
 *
 * Separated from `test-helpers.ts` to isolate the `@makaio/extension-opencode`
 * dependency from the framework-pure mock utilities. Import from this module
 * only in integration tests that exercise the full OpenCode import pipeline.
 * @packageDocumentation
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenCodeLogImporter } from '@makaio/extension-opencode';

export interface OpenCodeFixtureSession {
  importer: OpenCodeLogImporter;
  sessionContent: string;
  sessionFilePath: string;
  scanRoot: string;
  adapterSessionId: string;
  cleanup: () => Promise<void>;
}

class TestableOpenCodeLogImporter extends OpenCodeLogImporter {
  public constructor(
    options: { adapterId: string; adapterName: string },
    private readonly customLogDirectory?: string,
  ) {
    super(options);
  }

  public override getLogDirectory(): string {
    return this.customLogDirectory ?? super.getLogDirectory();
  }
}

/**
 * Create a real OpenCode importer backed by a temporary on-disk fixture tree.
 * @param options - Adapter registration identifiers for the importer
 * @returns Importer + session content/path for integration tests
 */
export async function createOpenCodeFixtureSession(options: {
  adapterId: string;
  adapterName: string;
  fixtureDir: string;
  includeMessages?: boolean;
  logDirectory?: 'scanRoot' | 'storageRoot' | string;
}): Promise<OpenCodeFixtureSession> {
  const fixtureDir = resolveOpenCodeFixtureDir(options.fixtureDir);
  const loadFixture = (name: string): string => readFileSync(join(fixtureDir, name), 'utf-8');
  const readJson = <T>(name: string): T => JSON.parse(loadFixture(name)) as T;

  const session = readJson<{ id: string }>('session.json');

  const dir = await mkdtemp(join(tmpdir(), 'log-import-opencode-'));
  try {
    const scanRoot = join(dir, 'project', 'test-slug');
    const storageRoot = join(scanRoot, 'storage');
    const includeMessages = options.includeMessages ?? true;
    const sessionFilePath = join(storageRoot, 'session', session.id, 'session.json');

    mkdirSync(join(storageRoot, 'session', session.id), { recursive: true });
    writeFileSync(sessionFilePath, loadFixture('session.json'));
    if (includeMessages) {
      const userMessage = readJson<{ id: string }>('message-user.json');
      const assistantMessage = readJson<{ id: string }>('message-assistant.json');
      const userPart = readJson<{ id: string }>('part-text-user.json');
      const assistantPart = readJson<{ id: string }>('part-text-assistant.json');
      const toolPart = readJson<{ id: string }>('part-tool.json');
      const finishPart = readJson<{ id: string }>('part-step-finish.json');

      mkdirSync(join(storageRoot, 'message', session.id), { recursive: true });
      mkdirSync(join(storageRoot, 'part', userMessage.id), { recursive: true });
      mkdirSync(join(storageRoot, 'part', assistantMessage.id), { recursive: true });
      writeFileSync(
        join(storageRoot, 'message', session.id, `${userMessage.id}.json`),
        loadFixture('message-user.json'),
      );
      writeFileSync(
        join(storageRoot, 'message', session.id, `${assistantMessage.id}.json`),
        loadFixture('message-assistant.json'),
      );
      writeFileSync(
        join(storageRoot, 'part', userMessage.id, `${userPart.id}.json`),
        loadFixture('part-text-user.json'),
      );
      writeFileSync(
        join(storageRoot, 'part', assistantMessage.id, `${assistantPart.id}.json`),
        loadFixture('part-text-assistant.json'),
      );
      writeFileSync(
        join(storageRoot, 'part', assistantMessage.id, `${toolPart.id}.json`),
        loadFixture('part-tool.json'),
      );
      writeFileSync(
        join(storageRoot, 'part', assistantMessage.id, `${finishPart.id}.json`),
        loadFixture('part-step-finish.json'),
      );
    }

    const customLogDirectory =
      options.logDirectory === 'scanRoot'
        ? scanRoot
        : options.logDirectory === 'storageRoot'
          ? storageRoot
          : options.logDirectory;
    const importer = new TestableOpenCodeLogImporter(
      { adapterId: options.adapterId, adapterName: options.adapterName },
      customLogDirectory,
    );

    return {
      importer,
      sessionContent: loadFixture('session.json'),
      sessionFilePath,
      scanRoot,
      adapterSessionId: session.id,
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Resolve the caller-provided OpenCode fixture directory.
 * @param fixtureDir - Absolute fixture directory supplied by the integration test.
 * @returns Absolute fixture directory for the OpenCode extension tests.
 * @throws If the expected fixture directory is absent.
 */
function resolveOpenCodeFixtureDir(fixtureDir: string): string {
  if (!existsSync(fixtureDir)) {
    throw new Error(`OpenCode fixture directory not found: ${fixtureDir}`);
  }

  return fixtureDir;
}
