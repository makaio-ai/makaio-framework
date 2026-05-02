/**
 * Tests for managed install descriptor types on `ClientDefinitionSchema`.
 *
 * Covers:
 * - `managedInstall` discriminated union for all three v1 strategies:
 *     `manifest-bucket`, `npm`, `github-release`
 * - `versionCommand` field validation
 * - `postInstall` descriptor field validation
 * - Rejection of unsupported / malformed descriptor shapes
 * - Integration via `createClientDefinition` to confirm the new fields
 *   round-trip correctly through schema parse + deep-freeze
 */
import { describe, expect, it } from 'vitest';
import {
  ClientDefinitionSchema,
  GithubReleaseInstallDescriptorSchema,
  ManifestBucketInstallDescriptorSchema,
  ManagedInstallDescriptorSchema,
  NpmInstallDescriptorSchema,
  PostInstallDescriptorSchema,
  createClientDefinition,
  type ClientDefinitionInput,
} from '@makaio/contracts/client';

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

function makeMinimalInput(overrides?: Partial<ClientDefinitionInput>): ClientDefinitionInput {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    defaultApprovalPolicy: 'always-ask',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// manifest-bucket descriptor
// ---------------------------------------------------------------------------

describe('ManifestBucketInstallDescriptorSchema', () => {
  const validDescriptor = {
    type: 'manifest-bucket',
    config: {
      baseUrl: 'https://storage.example.com/claude-code',
      versionIndex: { latest: 'version.txt' },
      manifestPath: 'manifest.json',
      manifestChecksumField: 'sha256',
      binaryPath: 'bin/claude',
    },
  } as const;

  it('parses a minimal manifest-bucket descriptor without archiveFormat', () => {
    const result = ManifestBucketInstallDescriptorSchema.parse(validDescriptor);

    expect(result.type).toBe('manifest-bucket');
    expect(result.config.baseUrl).toBe('https://storage.example.com/claude-code');
    expect(result.config.archiveFormat).toBeUndefined();
  });

  it('accepts all three archiveFormat variants', () => {
    for (const archiveFormat of ['raw', 'tar.gz', 'zip'] as const) {
      const result = ManifestBucketInstallDescriptorSchema.parse({
        ...validDescriptor,
        config: { ...validDescriptor.config, archiveFormat },
      });

      expect(result.config.archiveFormat).toBe(archiveFormat);
    }
  });

  it('rejects an invalid archiveFormat', () => {
    expect(
      ManifestBucketInstallDescriptorSchema.safeParse({
        ...validDescriptor,
        config: { ...validDescriptor.config, archiveFormat: 'gz' },
      }).success,
    ).toBe(false);
  });

  it('rejects a descriptor with an empty baseUrl', () => {
    expect(
      ManifestBucketInstallDescriptorSchema.safeParse({
        type: 'manifest-bucket',
        config: { ...validDescriptor.config, baseUrl: '' },
      }).success,
    ).toBe(false);
  });

  it('rejects a baseUrl that is not a valid URL', () => {
    expect(
      ManifestBucketInstallDescriptorSchema.safeParse({
        type: 'manifest-bucket',
        config: { ...validDescriptor.config, baseUrl: 'not-a-url' },
      }).success,
    ).toBe(false);
  });

  it('rejects a descriptor missing the config block', () => {
    expect(ManifestBucketInstallDescriptorSchema.safeParse({ type: 'manifest-bucket' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// npm descriptor
// ---------------------------------------------------------------------------

describe('NpmInstallDescriptorSchema', () => {
  it('parses a valid npm descriptor', () => {
    const result = NpmInstallDescriptorSchema.parse({
      type: 'npm',
      package: '@anthropic-ai/claude-code',
    });

    expect(result.type).toBe('npm');
    expect(result.package).toBe('@anthropic-ai/claude-code');
  });

  it('accepts a versioned package reference', () => {
    const result = NpmInstallDescriptorSchema.parse({
      type: 'npm',
      package: '@anthropic-ai/claude-code@1.2.3',
    });

    expect(result.package).toBe('@anthropic-ai/claude-code@1.2.3');
  });

  it('rejects an empty package name', () => {
    expect(NpmInstallDescriptorSchema.safeParse({ type: 'npm', package: '' }).success).toBe(false);
  });

  it('rejects a descriptor missing the package field', () => {
    expect(NpmInstallDescriptorSchema.safeParse({ type: 'npm' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// github-release descriptor
// ---------------------------------------------------------------------------

describe('GithubReleaseInstallDescriptorSchema', () => {
  const validDescriptor = {
    type: 'github-release',
    repo: 'anthropics/claude-code',
    assetPattern: {
      'darwin-arm64': 'claude-darwin-arm64.tar.gz',
      'darwin-x64': 'claude-darwin-x64.tar.gz',
      'linux-x64': 'claude-linux-x64.tar.gz',
    },
    archiveFormat: 'tar.gz',
  } as const;

  it('parses a valid github-release descriptor', () => {
    const result = GithubReleaseInstallDescriptorSchema.parse(validDescriptor);

    expect(result.type).toBe('github-release');
    expect(result.repo).toBe('anthropics/claude-code');
    expect(result.assetPattern['darwin-arm64']).toBe('claude-darwin-arm64.tar.gz');
  });

  it('accepts zip as archiveFormat', () => {
    const result = GithubReleaseInstallDescriptorSchema.parse({ ...validDescriptor, archiveFormat: 'zip' });

    expect(result.archiveFormat).toBe('zip');
  });

  it('rejects an invalid archiveFormat (raw is not supported for github-release)', () => {
    expect(GithubReleaseInstallDescriptorSchema.safeParse({ ...validDescriptor, archiveFormat: 'raw' }).success).toBe(
      false,
    );
  });

  it('rejects an empty repo string', () => {
    expect(GithubReleaseInstallDescriptorSchema.safeParse({ ...validDescriptor, repo: '' }).success).toBe(false);
  });

  it("rejects a repo string without a slash (must be 'owner/repo' format)", () => {
    expect(GithubReleaseInstallDescriptorSchema.safeParse({ ...validDescriptor, repo: 'noslash' }).success).toBe(false);
  });

  it("rejects a repo string with a leading slash (must be 'owner/repo' format)", () => {
    expect(GithubReleaseInstallDescriptorSchema.safeParse({ ...validDescriptor, repo: '/missing-owner' }).success).toBe(
      false,
    );
  });

  it('rejects a descriptor missing assetPattern', () => {
    const { assetPattern: _, ...withoutPattern } = validDescriptor;

    expect(GithubReleaseInstallDescriptorSchema.safeParse(withoutPattern).success).toBe(false);
  });

  it('rejects an assetPattern with an empty key', () => {
    expect(
      GithubReleaseInstallDescriptorSchema.safeParse({
        ...validDescriptor,
        assetPattern: { '': 'claude-darwin-arm64.tar.gz' },
      }).success,
    ).toBe(false);
  });

  it('rejects an assetPattern with an empty value', () => {
    expect(
      GithubReleaseInstallDescriptorSchema.safeParse({
        ...validDescriptor,
        assetPattern: { 'darwin-arm64': '' },
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ManagedInstallDescriptorSchema — discriminated union
// ---------------------------------------------------------------------------

describe('ManagedInstallDescriptorSchema', () => {
  it('routes manifest-bucket to the correct variant', () => {
    const result = ManagedInstallDescriptorSchema.parse({
      type: 'manifest-bucket',
      config: {
        baseUrl: 'https://example.com',
        versionIndex: { latest: 'version.txt' },
        manifestPath: 'manifest.json',
        manifestChecksumField: 'sha256',
        binaryPath: 'bin/claude',
      },
    });

    expect(result.type).toBe('manifest-bucket');
  });

  it('routes npm to the correct variant', () => {
    const result = ManagedInstallDescriptorSchema.parse({
      type: 'npm',
      package: 'claude',
    });

    expect(result.type).toBe('npm');
  });

  it('routes github-release to the correct variant', () => {
    const result = ManagedInstallDescriptorSchema.parse({
      type: 'github-release',
      repo: 'owner/repo',
      assetPattern: { 'linux-x64': 'binary-linux-x64.tar.gz' },
      archiveFormat: 'tar.gz',
    });

    expect(result.type).toBe('github-release');
  });

  it('rejects an unsupported strategy type', () => {
    expect(ManagedInstallDescriptorSchema.safeParse({ type: 'homebrew', formula: 'claude' }).success).toBe(false);
  });

  it('rejects a descriptor with a missing type discriminant', () => {
    expect(ManagedInstallDescriptorSchema.safeParse({ package: 'claude' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PostInstallDescriptorSchema
// ---------------------------------------------------------------------------

describe('PostInstallDescriptorSchema', () => {
  it('accepts a descriptor with only kind', () => {
    const result = PostInstallDescriptorSchema.parse({ kind: 'set-permissions' });

    expect(result.kind).toBe('set-permissions');
    expect(result.payload).toBeUndefined();
  });

  it('accepts a descriptor with a payload', () => {
    const result = PostInstallDescriptorSchema.parse({
      kind: 'run-script',
      payload: { script: 'chmod +x ./bin/claude', cwd: '/opt/makaio' },
    });

    expect(result.payload?.['script']).toBe('chmod +x ./bin/claude');
  });

  it('rejects an empty kind string', () => {
    expect(PostInstallDescriptorSchema.safeParse({ kind: '' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClientDefinitionSchema — managedInstall field
// ---------------------------------------------------------------------------

describe('ClientDefinitionSchema — managedInstall', () => {
  it('accepts a definition with a manifest-bucket install descriptor', () => {
    const result = ClientDefinitionSchema.parse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: {
          type: 'manifest-bucket',
          config: {
            baseUrl: 'https://storage.example.com',
            versionIndex: { latest: 'version.txt' },
            manifestPath: 'manifest.json',
            manifestChecksumField: 'sha256',
            binaryPath: 'bin/claude',
          },
        },
        versionCommand: ['bin/claude', '--version'],
      }),
    );

    expect(result.managedInstall?.type).toBe('manifest-bucket');
  });

  it('accepts a definition with an npm install descriptor', () => {
    const result = ClientDefinitionSchema.parse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: { type: 'npm', package: '@anthropic-ai/claude-code' },
        versionCommand: ['bin/claude', '--version'],
      }),
    );

    expect(result.managedInstall?.type).toBe('npm');
  });

  it('accepts a definition with a github-release install descriptor', () => {
    const result = ClientDefinitionSchema.parse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: {
          type: 'github-release',
          repo: 'anthropics/claude-code',
          assetPattern: { 'darwin-arm64': 'claude-darwin-arm64.tar.gz' },
          archiveFormat: 'zip',
        },
        versionCommand: ['bin/claude', '--version'],
      }),
    );

    expect(result.managedInstall?.type).toBe('github-release');
  });

  it('accepts a definition without managedInstall (field is optional)', () => {
    const result = ClientDefinitionSchema.parse(makeMinimalInput());

    expect(result.managedInstall).toBeUndefined();
  });

  it('rejects supportsManagedBinary without a managedInstall descriptor', () => {
    const result = ClientDefinitionSchema.safeParse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
      }),
    );

    expect(result.success).toBe(false);
  });

  it('rejects managedInstall when supportsManagedBinary is absent (bidirectional invariant)', () => {
    const result = ClientDefinitionSchema.safeParse(
      makeMinimalInput({
        managedInstall: { type: 'npm', package: '@anthropic-ai/claude-code' },
      }),
    );

    expect(result.success).toBe(false);
  });

  it('rejects managedInstall when supportsManagedBinary is explicitly false', () => {
    const result = ClientDefinitionSchema.safeParse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: false },
        managedInstall: { type: 'npm', package: '@anthropic-ai/claude-code' },
      }),
    );

    expect(result.success).toBe(false);
  });

  it('rejects an unsupported install descriptor type', () => {
    expect(
      ClientDefinitionSchema.safeParse(
        makeMinimalInput({
          managedInstall: { type: 'chocolatey', package: 'claude' } as never,
        }),
      ).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClientDefinitionSchema — versionCommand field
// ---------------------------------------------------------------------------

describe('ClientDefinitionSchema — versionCommand', () => {
  it('accepts a valid versionCommand array on an unmanaged definition', () => {
    const result = ClientDefinitionSchema.parse(makeMinimalInput({ versionCommand: ['claude', '--version'] }));

    expect(result.versionCommand).toEqual(['claude', '--version']);
  });

  it('unmanaged definitions may omit versionCommand', () => {
    const result = ClientDefinitionSchema.parse(makeMinimalInput());

    expect(result.versionCommand).toBeUndefined();
  });

  it('accepts versionCommand[0] as a relative path for managed definitions', () => {
    const result = ClientDefinitionSchema.parse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: { type: 'npm', package: '@anthropic-ai/claude-code' },
        versionCommand: ['bin/claude', '--version'],
      }),
    );

    expect(result.versionCommand).toEqual(['bin/claude', '--version']);
  });

  it('managed definitions with managedInstall must also provide versionCommand', () => {
    const result = ClientDefinitionSchema.safeParse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: { type: 'npm', package: '@anthropic-ai/claude-code' },
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('versionCommand');
    }
  });

  it('rejects an empty versionCommand array', () => {
    expect(ClientDefinitionSchema.safeParse(makeMinimalInput({ versionCommand: [] })).success).toBe(false);
  });

  it('rejects a versionCommand where an element is an empty string', () => {
    expect(ClientDefinitionSchema.safeParse(makeMinimalInput({ versionCommand: [''] })).success).toBe(false);
  });

  it('rejects managed definitions with an absolute versionCommand[0]', () => {
    const result = ClientDefinitionSchema.safeParse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: { type: 'npm', package: '@anthropic-ai/claude-code' },
        versionCommand: ['/usr/bin/claude', '--version'],
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('versionCommand.0');
    }
  });

  it('rejects managed definitions with path traversal in versionCommand[0]', () => {
    const result = ClientDefinitionSchema.safeParse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: { type: 'npm', package: '@anthropic-ai/claude-code' },
        versionCommand: ['../bin/claude', '--version'],
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('versionCommand.0');
    }
  });

  it('rejects managed definitions with Windows rooted backslash versionCommand[0]', () => {
    const result = ClientDefinitionSchema.safeParse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: { type: 'npm', package: '@anthropic-ai/claude-code' },
        versionCommand: ['\\Windows\\System32\\cmd.exe', '--version'],
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('versionCommand.0');
    }
  });

  it.each([
    ['Windows drive path with backslashes', 'C:\\Windows\\System32\\cmd.exe'],
    ['Windows drive path with slashes', 'C:/Windows/System32/cmd.exe'],
    ['Windows UNC path', '\\\\server\\share\\cmd.exe'],
    ['POSIX traversal after a path segment', 'bin/../claude'],
    ['Windows traversal after a path segment', 'bin\\..\\claude.exe'],
  ])('rejects managed definitions with %s in versionCommand[0]', (_label, executable) => {
    const result = ClientDefinitionSchema.safeParse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: { type: 'npm', package: '@anthropic-ai/claude-code' },
        versionCommand: [executable, '--version'],
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('versionCommand.0');
    }
  });

  it('accepts managed definitions with nested relative versionCommand[0]', () => {
    const result = ClientDefinitionSchema.parse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: { type: 'npm', package: '@anthropic-ai/claude-code' },
        versionCommand: ['bin/claude', '--version'],
      }),
    );

    expect(result.versionCommand).toEqual(['bin/claude', '--version']);
  });
});

// ---------------------------------------------------------------------------
// ClientDefinitionSchema — postInstall field
// ---------------------------------------------------------------------------

describe('ClientDefinitionSchema — postInstall', () => {
  it('accepts a definition with a postInstall descriptor', () => {
    const result = ClientDefinitionSchema.parse(
      makeMinimalInput({
        postInstall: { kind: 'set-permissions', payload: { mode: '0755' } },
      }),
    );

    expect(result.postInstall?.kind).toBe('set-permissions');
    expect(result.postInstall?.payload?.['mode']).toBe('0755');
  });

  it('accepts a definition without postInstall (field is optional)', () => {
    const result = ClientDefinitionSchema.parse(makeMinimalInput());

    expect(result.postInstall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createClientDefinition — full integration with new fields
// ---------------------------------------------------------------------------

describe('createClientDefinition — managed install integration', () => {
  it('returns a frozen definition with managedInstall, versionCommand, and postInstall', () => {
    const definition = createClientDefinition({
      id: 'claude-code',
      name: 'Claude Code',
      defaultApprovalPolicy: 'full-access',
      runtimeCapabilities: { supportsManagedBinary: true },
      managedInstall: {
        type: 'manifest-bucket',
        config: {
          baseUrl: 'https://storage.example.com/claude-code',
          versionIndex: { latest: 'version.txt' },
          manifestPath: 'manifest.json',
          manifestChecksumField: 'sha256',
          binaryPath: 'bin/claude',
          archiveFormat: 'tar.gz',
        },
      },
      versionCommand: ['claude', '--version'],
      postInstall: { kind: 'set-permissions' },
    });

    expect(definition.runtimeCapabilities.supportsManagedBinary).toBe(true);
    expect(definition.managedInstall?.type).toBe('manifest-bucket');
    expect(definition.versionCommand).toEqual(['claude', '--version']);
    expect(definition.postInstall?.kind).toBe('set-permissions');
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.managedInstall)).toBe(true);
    expect(Object.isFrozen(definition.versionCommand)).toBe(true);
  });

  it('returns a frozen definition with an npm install descriptor', () => {
    const definition = createClientDefinition({
      id: 'codex',
      name: 'Codex',
      defaultApprovalPolicy: 'always-ask',
      runtimeCapabilities: { supportsManagedBinary: true },
      managedInstall: { type: 'npm', package: 'openai-codex' },
      versionCommand: ['codex', '-v'],
    });

    expect(definition.managedInstall?.type).toBe('npm');
    expect(Object.isFrozen(definition.managedInstall)).toBe(true);
  });

  it('returns a frozen definition with a github-release install descriptor', () => {
    const definition = createClientDefinition({
      id: 'my-client',
      name: 'My Client',
      defaultApprovalPolicy: 'always-ask',
      runtimeCapabilities: { supportsManagedBinary: true },
      managedInstall: {
        type: 'github-release',
        repo: 'owner/my-client',
        assetPattern: { 'linux-x64': 'my-client-linux-x64.tar.gz' },
        archiveFormat: 'tar.gz',
      },
      versionCommand: ['bin/my-client', '--version'],
    });

    expect(definition.managedInstall?.type).toBe('github-release');
    if (definition.managedInstall?.type === 'github-release') {
      expect(definition.managedInstall.repo).toBe('owner/my-client');
    }
  });
});
