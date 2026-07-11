import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AdapterFile, type ProviderConfigFile } from '@makaio/contracts/config';
import { FileAdapterConfigRepository } from '../config-repository.js';

interface TestContext {
  readonly makaioDir: string;
  readonly repository: FileAdapterConfigRepository;
  readonly cleanup: () => Promise<void>;
}

class FailingReplaceRepository extends FileAdapterConfigRepository {
  protected override async replaceFile(): Promise<void> {
    throw new Error('rename failed');
  }
}

class ExposedReplaceRepository extends FileAdapterConfigRepository {
  private readonly failingRenameCalls = new Map<number, string>();
  private renameCallCount = 0;

  public setFailRenameOnce(): void {
    this.failingRenameCalls.set(1, 'EPERM');
  }

  public setFailInitialAndReplacementRename(): void {
    this.failingRenameCalls.set(1, 'EPERM');
    this.failingRenameCalls.set(3, 'EIO');
  }

  public async replacePreparedFile(sourcePath: string, targetPath: string): Promise<void> {
    await this.replaceFile(sourcePath, targetPath);
  }

  protected override async renameFile(sourcePath: string, targetPath: string): Promise<void> {
    this.renameCallCount += 1;
    const errorCode = this.failingRenameCalls.get(this.renameCallCount);
    if (errorCode) {
      const error = Object.assign(new Error('rename failed'), { code: errorCode });
      throw error;
    }
    await super.renameFile(sourcePath, targetPath);
  }
}

/**
 * Create a temporary repository test context.
 * @returns Temp Makaio home and repository instance.
 */
async function createTestContext(): Promise<TestContext> {
  const rootDir = path.join(os.tmpdir(), `makaio-config-repository-${crypto.randomUUID()}`);
  const makaioDir = path.join(rootDir, '.makaio');
  await fs.mkdir(makaioDir, { recursive: true });

  const repository = new FileAdapterConfigRepository({
    providerConfigsDir: path.join(makaioDir, 'provider-configs'),
    adaptersDir: path.join(makaioDir, 'adapters'),
  });

  return {
    makaioDir,
    repository,
    cleanup: async () => {
      await fs.rm(rootDir, { recursive: true, force: true });
    },
  };
}

/**
 * Write a text file to the temp `.makaio` tree.
 * @param filePath - Absolute file path.
 * @param content - File content to persist.
 */
async function writeTextFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

/**
 * Write a JSON file to the temp `.makaio` tree.
 * @param filePath - Absolute file path.
 * @param value - JSON value to persist.
 */
async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Build a minimal canonical no-auth provider config for repository tests.
 * @param definitionId - Provider definition identifier.
 * @returns Canonical v2 provider config.
 */
function createNoAuthConfig(definitionId: string): ProviderConfigFile {
  return {
    $schema: 'makaio/provider-config/v2',
    definitionId,
    auth: {
      mode: 'none',
      method: { owner: 'provider', providerDefinitionId: definitionId, methodId: 'none' },
    },
  };
}

describe('FileAdapterConfigRepository', () => {
  let ctx: TestContext;
  let warnSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(async () => {
    ctx = await createTestContext();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warnSpy?.mockRestore();
    await ctx.cleanup();
  });

  it('loads validated provider config files and uses the file stem as the providerConfigId', async () => {
    const validConfig: ProviderConfigFile = {
      ...createNoAuthConfig('anthropic'),
      name: 'Anthropic Work',
      enabled: true,
    };

    await writeJsonFile(path.join(ctx.makaioDir, 'provider-configs', 'anthropic.work.json'), validConfig);
    await writeJsonFile(path.join(ctx.makaioDir, 'provider-configs', 'Anthropic.Work.json'), validConfig);
    await writeJsonFile(path.join(ctx.makaioDir, 'provider-configs', 'noncanonical.json.json'), validConfig);
    await writeJsonFile(path.join(ctx.makaioDir, 'provider-configs', ' spaced .json'), validConfig);
    const { configs } = await ctx.repository.loadProviderConfigs();

    expect([...configs.keys()]).toEqual(['anthropic.work']);
    expect(configs.get('anthropic.work')).toEqual(validConfig);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('fails malformed provider JSON with a sanitized typed diagnostic', async () => {
    const filePath = path.join(ctx.makaioDir, 'provider-configs', 'broken.json');
    await writeTextFile(filePath, '{ secret-looking-invalid-json');

    const load = ctx.repository.loadProviderConfigs();

    await expect(load).rejects.toMatchObject({
      name: 'ProviderConfigDiagnosticError',
      code: 'invalid-provider-config',
      source: 'broken.json',
    });
    await expect(load).rejects.not.toThrow(filePath);
    await expect(load).rejects.not.toThrow('secret-looking-invalid-json');
  });

  it.each([
    {
      name: 'v1 schema',
      value: { $schema: 'makaio/provider-config/v1', definitionId: 'anthropic' },
      code: 'legacy-provider-config',
    },
    {
      name: 'legacy credentials field',
      value: {
        ...createNoAuthConfig('anthropic'),
        credentials: { apiKey: 'env:ANTHROPIC_API_KEY' },
      },
      code: 'legacy-provider-config',
    },
    {
      name: 'legacy sentinel field',
      value: { ...createNoAuthConfig('anthropic'), isSentinel: false },
      code: 'legacy-provider-config',
    },
    {
      name: 'missing required auth',
      value: { $schema: 'makaio/provider-config/v2', definitionId: 'anthropic' },
      code: 'invalid-provider-config',
    },
  ])('fails loading $name with a typed reset diagnostic', async ({ value, code }) => {
    const filePath = path.join(ctx.makaioDir, 'provider-configs', 'legacy.json');
    await writeJsonFile(filePath, value);

    await expect(ctx.repository.loadProviderConfigs()).rejects.toMatchObject({
      name: 'ProviderConfigDiagnosticError',
      code,
      source: 'legacy',
    });
  });

  it('loads validated adapter files and uses the file stem as the adapter name', async () => {
    const validConfig: AdapterFile = {
      $schema: 'makaio/adapter-config/v1',
      enabled: true,
      displayName: 'Claude Code',
      settings: { maxConcurrency: 3 },
      bindings: [{ providerConfigId: 'anthropic.work', isDefault: true }],
    };

    await writeJsonFile(path.join(ctx.makaioDir, 'adapters', 'claude.code.json'), validConfig);
    await writeJsonFile(path.join(ctx.makaioDir, 'adapters', 'Claude.Code.json'), validConfig);
    await writeJsonFile(path.join(ctx.makaioDir, 'adapters', 'noncanonical.json.json'), validConfig);
    await writeJsonFile(path.join(ctx.makaioDir, 'adapters', ' spaced .json'), validConfig);
    await writeTextFile(path.join(ctx.makaioDir, 'adapters', 'broken.json'), '{ invalid json');
    await writeJsonFile(path.join(ctx.makaioDir, 'adapters', 'wrong-schema.json'), {
      $schema: 'makaio/adapter-config/v1',
      displayName: 'Missing bindings shape',
      bindings: [{ isDefault: true }],
    });

    const { configs } = await ctx.repository.loadAdapterConfigs();

    expect([...configs.keys()]).toEqual(['claude.code']);
    expect(configs.get('claude.code')).toEqual(validConfig);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns empty sets when the config directories do not exist', async () => {
    await fs.rm(ctx.makaioDir, { recursive: true, force: true });

    const [providerSet, adapterSet] = await Promise.all([
      ctx.repository.loadProviderConfigs(),
      ctx.repository.loadAdapterConfigs(),
    ]);

    expect(providerSet.configs.size).toBe(0);
    expect(adapterSet.configs.size).toBe(0);
  });

  it('writes provider config files by creating parent directories and persisting validated JSON', async () => {
    const config: ProviderConfigFile = {
      ...createNoAuthConfig('openai'),
      name: 'OpenAI Work',
      isDefault: true,
    };

    await ctx.repository.writeProviderConfig('openai.work', config);

    const filePath = path.join(ctx.makaioDir, 'provider-configs', 'openai.work.json');
    const content = await fs.readFile(filePath, 'utf-8');

    expect(JSON.parse(content)).toEqual(config);

    const { configs } = await ctx.repository.loadProviderConfigs();
    expect(configs.get('openai.work')).toEqual(config);
  });

  it('keeps the visible provider config file unchanged when the final atomic replace fails', async () => {
    const filePath = path.join(ctx.makaioDir, 'provider-configs', 'atomic.json');
    const original = {
      ...createNoAuthConfig('openai'),
      name: 'Original',
      enabled: true,
    };
    await writeJsonFile(filePath, original);

    const failingRepository = new FailingReplaceRepository({
      providerConfigsDir: path.join(ctx.makaioDir, 'provider-configs'),
      adaptersDir: path.join(ctx.makaioDir, 'adapters'),
    });

    await expect(
      failingRepository.writeProviderConfig('atomic', {
        ...createNoAuthConfig('openai'),
        name: 'Updated',
        enabled: false,
      }),
    ).rejects.toThrow('rename failed');

    expect(JSON.parse(await fs.readFile(filePath, 'utf-8'))).toEqual(original);
    expect(await fs.readdir(path.dirname(filePath))).toEqual(['atomic.json']);
  });

  it('tightens permissions on an existing provider config file when rewriting it', async () => {
    const filePath = path.join(ctx.makaioDir, 'provider-configs', 'existing.json');
    await writeJsonFile(filePath, {
      ...createNoAuthConfig('openai'),
      name: 'Existing',
    });
    await fs.chmod(filePath, 0o644);

    await ctx.repository.writeProviderConfig('existing', {
      ...createNoAuthConfig('openai'),
      name: 'Existing',
      enabled: false,
    });

    const mode = (await fs.stat(filePath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('replaces an existing file when rename initially fails with a Windows-style permission error', async () => {
    const repository = new ExposedReplaceRepository({
      providerConfigsDir: path.join(ctx.makaioDir, 'provider-configs'),
      adaptersDir: path.join(ctx.makaioDir, 'adapters'),
    });
    const directoryPath = path.join(ctx.makaioDir, 'provider-configs');
    const targetPath = path.join(directoryPath, 'existing.json');
    const sourcePath = path.join(directoryPath, 'existing.json.tmp');
    await fs.mkdir(directoryPath, { recursive: true });
    await fs.writeFile(targetPath, 'old\n', 'utf-8');
    await fs.writeFile(sourcePath, 'new\n', 'utf-8');
    repository.setFailRenameOnce();

    await repository.replacePreparedFile(sourcePath, targetPath);

    expect(await fs.readFile(targetPath, 'utf-8')).toBe('new\n');
    expect(await fs.readdir(directoryPath)).toEqual(['existing.json']);
  });

  it('restores the existing file when fallback replacement cannot install the new file', async () => {
    const repository = new ExposedReplaceRepository({
      providerConfigsDir: path.join(ctx.makaioDir, 'provider-configs'),
      adaptersDir: path.join(ctx.makaioDir, 'adapters'),
    });
    const directoryPath = path.join(ctx.makaioDir, 'provider-configs');
    const targetPath = path.join(directoryPath, 'existing.json');
    const sourcePath = path.join(directoryPath, 'existing.json.tmp');
    await fs.mkdir(directoryPath, { recursive: true });
    await fs.writeFile(targetPath, 'old\n', 'utf-8');
    await fs.writeFile(sourcePath, 'new\n', 'utf-8');
    repository.setFailInitialAndReplacementRename();

    await expect(repository.replacePreparedFile(sourcePath, targetPath)).rejects.toThrow('rename failed');

    expect(await fs.readFile(targetPath, 'utf-8')).toBe('old\n');
  });

  it('deletes provider config files and returns false when the file is missing', async () => {
    const filePath = path.join(ctx.makaioDir, 'provider-configs', 'delete-me.json');
    await writeJsonFile(filePath, createNoAuthConfig('openai'));

    await expect(ctx.repository.deleteProviderConfig('delete-me')).resolves.toBe(true);
    await expect(ctx.repository.deleteProviderConfig('delete-me')).resolves.toBe(false);
  });

  it('deletes adapter files and returns false when the file is missing', async () => {
    const filePath = path.join(ctx.makaioDir, 'adapters', 'delete-me.json');
    await writeJsonFile(filePath, {
      $schema: 'makaio/adapter-config/v1',
      displayName: 'Delete Me',
    });

    await expect(ctx.repository.deleteAdapterFile('delete-me')).resolves.toBe(true);
    await expect(ctx.repository.deleteAdapterFile('delete-me')).resolves.toBe(false);
  });

  it('rejects non-canonical ids and names at the write/delete boundary', async () => {
    const providerConfig = createNoAuthConfig('anthropic');
    const adapterConfig: AdapterFile = {
      $schema: 'makaio/adapter-config/v1',
    };

    await expect(ctx.repository.writeProviderConfig('../escape', providerConfig)).rejects.toThrow(
      'Invalid canonical provider config id: ../escape',
    );
    await expect(ctx.repository.writeProviderConfig('foo.json', providerConfig)).rejects.toThrow(
      'Invalid canonical provider config id: foo.json',
    );
    await expect(ctx.repository.writeProviderConfig('provider:bad', providerConfig)).rejects.toThrow(
      'Invalid canonical provider config id: provider:bad',
    );
    await expect(ctx.repository.writeProviderConfig('OpenAI.Work', providerConfig)).rejects.toThrow(
      'Invalid canonical provider config id: OpenAI.Work',
    );
    await expect(ctx.repository.writeAdapterFile('..\\escape', adapterConfig)).rejects.toThrow(
      'Invalid canonical adapter name: ..\\escape',
    );
    await expect(ctx.repository.writeAdapterFile('Claude.Code', adapterConfig)).rejects.toThrow(
      'Invalid canonical adapter name: Claude.Code',
    );
    await expect(ctx.repository.deleteProviderConfig('../escape')).rejects.toThrow(
      'Invalid canonical provider config id: ../escape',
    );
  });

  it('writes adapter files by creating parent directories and persisting validated JSON', async () => {
    const config: AdapterFile = {
      $schema: 'makaio/adapter-config/v1',
      enabled: false,
      displayName: 'OpenAI Node',
      settings: { temperature: 0.2 },
      bindings: [{ providerConfigId: 'openai.work' }],
    };

    await ctx.repository.writeAdapterFile('openai.node', config);

    const filePath = path.join(ctx.makaioDir, 'adapters', 'openai.node.json');
    const content = await fs.readFile(filePath, 'utf-8');

    expect(JSON.parse(content)).toEqual(config);

    const { configs } = await ctx.repository.loadAdapterConfigs();
    expect(configs.get('openai.node')).toEqual(config);
  });
});
