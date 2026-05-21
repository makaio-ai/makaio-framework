/**
 * Tests for managed install descriptor types on `ClientDefinitionSchema`.
 *
 * Covers:
 * - `managedInstall` discriminated union for the two supported strategies:
 *     `npm`, `signed-binary-bucket`
 * - Rejection of removed `manifest-bucket` and `github-release` strategies
 * - `versionCommand` field validation (platform-aware `VersionCommandSchema`)
 * - `postInstall` descriptor field validation
 * - Rejection of unsupported / malformed descriptor shapes
 * - Integration via `createClientDefinition` to confirm the new fields
 *   round-trip correctly through schema parse + deep-freeze
 */
import { describe, expect, it } from 'vitest';
import {
  ClientDefinitionSchema,
  ManagedInstallDescriptorSchema,
  NpmInstallDescriptorSchema,
  PostInstallDescriptorSchema,
  SignedBinaryBucketInstallDescriptorSchema,
  VersionCommandSchema,
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
    version: '0.1.0',
    defaultApprovalPolicy: 'always-ask',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// NpmInstallDescriptorSchema
// ---------------------------------------------------------------------------

describe('NpmInstallDescriptorSchema', () => {
  it('accepts npm managed install with an exact version pin', () => {
    const result = NpmInstallDescriptorSchema.parse({
      type: 'npm',
      package: '@openai/codex',
      version: '0.130.0',
    });

    expect(result).toEqual({
      type: 'npm',
      package: '@openai/codex',
      version: '0.130.0',
    });
  });

  it('rejects npm managed install without an exact version pin', () => {
    expect(NpmInstallDescriptorSchema.safeParse({ type: 'npm', package: '@openai/codex' }).success).toBe(false);
  });

  it('rejects an empty package name', () => {
    expect(NpmInstallDescriptorSchema.safeParse({ type: 'npm', package: '', version: '1.0.0' }).success).toBe(false);
  });

  it('rejects a non-semver version string', () => {
    expect(
      NpmInstallDescriptorSchema.safeParse({ type: 'npm', package: '@openai/codex', version: '^1.0.0' }).success,
    ).toBe(false);
  });

  it.each([
    ['unscoped package', 'codex@0.130.0'],
    ['scoped package', '@openai/codex@0.130.0'],
  ])('rejects inline version suffixes on %s names', (_label, packageName) => {
    expect(
      NpmInstallDescriptorSchema.safeParse({ type: 'npm', package: packageName, version: '0.130.0' }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SignedBinaryBucketInstallDescriptorSchema
// ---------------------------------------------------------------------------

describe('SignedBinaryBucketInstallDescriptorSchema', () => {
  const validDescriptor = {
    type: 'signed-binary-bucket',
    version: '2.1.143',
    config: {
      baseUrl: 'https://downloads.claude.ai/claude-code-releases',
      manifestPathTemplate: '{version}/manifest.json',
      manifestSignaturePathTemplate: '{version}/manifest.json.sig',
      publicKeyUrl: 'https://downloads.claude.ai/keys/claude-code.asc',
      publicKeyFingerprint: '31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE',
      binaryPathTemplate: '{version}/{platform}/{binary}',
      platforms: {
        'darwin-arm64': 'darwin-arm64',
        'darwin-x64': 'darwin-x64',
        'linux-arm64': 'linux-arm64',
        'linux-x64': 'linux-x64',
        'linux-arm64-musl': 'linux-arm64-musl',
        'linux-x64-musl': 'linux-x64-musl',
        'win32-arm64': 'win32-arm64',
        'win32-x64': 'win32-x64',
      },
    },
  } as const;

  it('accepts signed binary bucket managed install with exact version pin and signature metadata', () => {
    const result = SignedBinaryBucketInstallDescriptorSchema.parse(validDescriptor);

    expect(result.type).toBe('signed-binary-bucket');
    expect(result.version).toBe('2.1.143');
    expect(result.config.publicKeyFingerprint).toBe('31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE');
  });

  it('rejects signed binary bucket without an exact version pin', () => {
    const { version: _, ...withoutVersion } = validDescriptor;

    expect(SignedBinaryBucketInstallDescriptorSchema.safeParse(withoutVersion).success).toBe(false);
  });

  it('rejects a non-semver version string', () => {
    expect(SignedBinaryBucketInstallDescriptorSchema.safeParse({ ...validDescriptor, version: 'latest' }).success).toBe(
      false,
    );
  });

  it('rejects a descriptor missing the config block', () => {
    expect(
      SignedBinaryBucketInstallDescriptorSchema.safeParse({
        type: 'signed-binary-bucket',
        version: '1.0.0',
      }).success,
    ).toBe(false);
  });

  it('rejects a non-URL baseUrl', () => {
    expect(
      SignedBinaryBucketInstallDescriptorSchema.safeParse({
        ...validDescriptor,
        config: { ...validDescriptor.config, baseUrl: 'not-a-url' },
      }).success,
    ).toBe(false);
  });

  it('rejects a non-URL publicKeyUrl', () => {
    expect(
      SignedBinaryBucketInstallDescriptorSchema.safeParse({
        ...validDescriptor,
        config: { ...validDescriptor.config, publicKeyUrl: 'not-a-url' },
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ManagedInstallDescriptorSchema — discriminated union
// ---------------------------------------------------------------------------

describe('ManagedInstallDescriptorSchema', () => {
  it('routes npm to the correct variant', () => {
    const result = ManagedInstallDescriptorSchema.parse({
      type: 'npm',
      package: '@openai/codex',
      version: '0.130.0',
    });

    expect(result.type).toBe('npm');
  });

  it('routes signed-binary-bucket to the correct variant', () => {
    const result = ManagedInstallDescriptorSchema.parse({
      type: 'signed-binary-bucket',
      version: '2.1.143',
      config: {
        baseUrl: 'https://downloads.claude.ai/releases',
        manifestPathTemplate: '{version}/manifest.json',
        manifestSignaturePathTemplate: '{version}/manifest.json.sig',
        publicKeyUrl: 'https://downloads.claude.ai/keys/key.asc',
        publicKeyFingerprint: 'AABB CCDD',
        binaryPathTemplate: '{version}/{platform}/{binary}',
        platforms: { 'linux-x64': 'linux-x64' },
      },
    });

    expect(result.type).toBe('signed-binary-bucket');
  });

  it('rejects removed manifest-bucket and github-release strategies', () => {
    expect(ManagedInstallDescriptorSchema.safeParse({ type: 'manifest-bucket' }).success).toBe(false);
    expect(ManagedInstallDescriptorSchema.safeParse({ type: 'github-release' }).success).toBe(false);
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
// VersionCommandSchema
// ---------------------------------------------------------------------------

describe('VersionCommandSchema', () => {
  it('accepts a string executable with default args', () => {
    const result = VersionCommandSchema.parse({ executable: 'bin/claude', args: ['--version'] });

    expect(result.executable).toBe('bin/claude');
    expect(result.args).toEqual(['--version']);
  });

  it('defaults args to an empty array when omitted', () => {
    const result = VersionCommandSchema.parse({ executable: 'bin/claude' });

    expect(result.args).toEqual([]);
  });

  it('accepts a platform-keyed executable object', () => {
    const result = VersionCommandSchema.parse({
      executable: {
        default: 'bin/claude',
        win32: 'bin/claude.exe',
      },
      args: ['--version'],
    });

    expect(typeof result.executable).toBe('object');
    if (typeof result.executable === 'object') {
      expect(result.executable.default).toBe('bin/claude');
      expect(result.executable.win32).toBe('bin/claude.exe');
      expect(result.executable.darwin).toBeUndefined();
    }
  });

  it('rejects an empty string executable', () => {
    expect(VersionCommandSchema.safeParse({ executable: '' }).success).toBe(false);
  });

  it('rejects a platform object with an empty default', () => {
    expect(VersionCommandSchema.safeParse({ executable: { default: '' } }).success).toBe(false);
  });

  it('rejects unknown top-level fields', () => {
    expect(VersionCommandSchema.safeParse({ executable: 'bin/claude', windows: 'bin/claude.exe' }).success).toBe(false);
  });

  it('rejects unknown platform executable keys', () => {
    expect(
      VersionCommandSchema.safeParse({
        executable: {
          default: 'bin/claude',
          windows: 'bin/claude.exe',
        },
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClientDefinitionSchema — managedInstall field
// ---------------------------------------------------------------------------

describe('ClientDefinitionSchema — managedInstall', () => {
  it('accepts a definition with an npm install descriptor', () => {
    const result = ClientDefinitionSchema.parse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: { type: 'npm', package: '@anthropic-ai/claude-code', version: '1.2.3' },
        versionCommand: { executable: 'bin/claude', args: ['--version'] },
      }),
    );

    expect(result.managedInstall?.type).toBe('npm');
  });

  it('accepts a definition with a signed-binary-bucket install descriptor', () => {
    const result = ClientDefinitionSchema.parse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: {
          type: 'signed-binary-bucket',
          version: '2.1.143',
          config: {
            baseUrl: 'https://downloads.claude.ai/releases',
            manifestPathTemplate: '{version}/manifest.json',
            manifestSignaturePathTemplate: '{version}/manifest.json.sig',
            publicKeyUrl: 'https://downloads.claude.ai/keys/key.asc',
            publicKeyFingerprint: 'AABB CCDD',
            binaryPathTemplate: '{version}/{platform}/{binary}',
            platforms: { 'linux-x64': 'linux-x64' },
          },
        },
        versionCommand: { executable: 'bin/claude', args: ['--version'] },
      }),
    );

    expect(result.managedInstall?.type).toBe('signed-binary-bucket');
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
        managedInstall: { type: 'npm', package: '@anthropic-ai/claude-code', version: '1.2.3' },
      }),
    );

    expect(result.success).toBe(false);
  });

  it('rejects managedInstall when supportsManagedBinary is explicitly false', () => {
    const result = ClientDefinitionSchema.safeParse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: false },
        managedInstall: { type: 'npm', package: '@anthropic-ai/claude-code', version: '1.2.3' },
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
// ClientDefinitionSchema — versionCommand field (VersionCommandSchema)
// ---------------------------------------------------------------------------

describe('ClientDefinitionSchema — versionCommand', () => {
  it('accepts a string executable versionCommand on a managed definition', () => {
    const result = ClientDefinitionSchema.parse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: { type: 'npm', package: '@anthropic-ai/claude-code', version: '1.2.3' },
        versionCommand: { executable: 'bin/claude', args: ['--version'] },
      }),
    );

    expect(result.versionCommand?.executable).toBe('bin/claude');
    expect(result.versionCommand?.args).toEqual(['--version']);
  });

  it('accepts a platform-keyed versionCommand on a managed definition', () => {
    const result = ClientDefinitionSchema.parse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: { type: 'npm', package: '@anthropic-ai/claude-code', version: '1.2.3' },
        versionCommand: {
          executable: { default: 'bin/claude', win32: 'bin/claude.exe' },
          args: ['--version'],
        },
      }),
    );

    const exec = result.versionCommand?.executable;
    expect(typeof exec).toBe('object');
    if (exec && typeof exec === 'object') {
      expect(exec.default).toBe('bin/claude');
      expect(exec.win32).toBe('bin/claude.exe');
    }
  });

  it('unmanaged definitions may omit versionCommand', () => {
    const result = ClientDefinitionSchema.parse(makeMinimalInput());

    expect(result.versionCommand).toBeUndefined();
  });

  it('managed definitions with managedInstall must also provide versionCommand', () => {
    const result = ClientDefinitionSchema.safeParse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: { type: 'npm', package: '@anthropic-ai/claude-code', version: '1.2.3' },
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('versionCommand');
    }
  });

  it('rejects managed definitions with an absolute string executable', () => {
    const result = ClientDefinitionSchema.safeParse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: { type: 'npm', package: '@anthropic-ai/claude-code', version: '1.2.3' },
        versionCommand: { executable: '/usr/bin/claude', args: ['--version'] },
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('versionCommand.executable');
    }
  });

  it('rejects managed definitions with path traversal in string executable', () => {
    const result = ClientDefinitionSchema.safeParse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: { type: 'npm', package: '@anthropic-ai/claude-code', version: '1.2.3' },
        versionCommand: { executable: '../bin/claude', args: ['--version'] },
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('versionCommand.executable');
    }
  });

  it('rejects managed definitions with an absolute default executable in platform object', () => {
    const result = ClientDefinitionSchema.safeParse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: { type: 'npm', package: '@anthropic-ai/claude-code', version: '1.2.3' },
        versionCommand: {
          executable: { default: '/usr/bin/claude', win32: 'bin/claude.exe' },
          args: ['--version'],
        },
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('versionCommand.executable.default');
    }
  });

  it('rejects managed definitions with path traversal in a platform-specific executable', () => {
    const result = ClientDefinitionSchema.safeParse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: { type: 'npm', package: '@anthropic-ai/claude-code', version: '1.2.3' },
        versionCommand: {
          executable: { default: 'bin/claude', win32: '..\\bin\\claude.exe' },
          args: ['--version'],
        },
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('versionCommand.executable.win32');
    }
  });

  it.each([
    ['Windows drive path with backslashes', 'C:\\Windows\\System32\\cmd.exe'],
    ['Windows drive path with slashes', 'C:/Windows/System32/cmd.exe'],
    ['Windows drive-relative path', 'C:Windows\\System32\\cmd.exe'],
    ['Windows rooted backslash path', '\\Windows\\System32\\cmd.exe'],
    ['POSIX traversal after a path segment', 'bin/../claude'],
    ['Windows traversal after a path segment', 'bin\\..\\claude.exe'],
  ])('rejects managed definitions with %s in string executable', (_label, executable) => {
    const result = ClientDefinitionSchema.safeParse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: { type: 'npm', package: '@anthropic-ai/claude-code', version: '1.2.3' },
        versionCommand: { executable, args: ['--version'] },
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('versionCommand.executable');
    }
  });

  it('accepts managed definitions with nested relative string executable', () => {
    const result = ClientDefinitionSchema.parse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: { type: 'npm', package: '@anthropic-ai/claude-code', version: '1.2.3' },
        versionCommand: { executable: 'bin/claude', args: ['--version'] },
      }),
    );

    expect(result.versionCommand?.executable).toBe('bin/claude');
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
  it('returns a frozen definition with npm managedInstall, versionCommand, and postInstall', () => {
    const definition = createClientDefinition({
      id: 'claude-code',
      name: 'Claude Code',
      version: '0.1.0',
      defaultApprovalPolicy: 'full-access',
      runtimeCapabilities: { supportsManagedBinary: true },
      managedInstall: {
        type: 'npm',
        package: '@anthropic-ai/claude-code',
        version: '1.2.3',
      },
      versionCommand: { executable: 'bin/claude', args: ['--version'] },
      postInstall: { kind: 'set-permissions' },
    });

    expect(definition.runtimeCapabilities.supportsManagedBinary).toBe(true);
    expect(definition.managedInstall?.type).toBe('npm');
    expect(definition.versionCommand?.executable).toBe('bin/claude');
    expect(definition.versionCommand?.args).toEqual(['--version']);
    expect(definition.postInstall?.kind).toBe('set-permissions');
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.managedInstall)).toBe(true);
    expect(Object.isFrozen(definition.versionCommand)).toBe(true);
  });

  it('returns a frozen definition with signed-binary-bucket install descriptor', () => {
    const definition = createClientDefinition({
      id: 'codex',
      name: 'Codex',
      version: '0.1.0',
      defaultApprovalPolicy: 'always-ask',
      runtimeCapabilities: { supportsManagedBinary: true },
      managedInstall: {
        type: 'signed-binary-bucket',
        version: '2.1.143',
        config: {
          baseUrl: 'https://downloads.claude.ai/releases',
          manifestPathTemplate: '{version}/manifest.json',
          manifestSignaturePathTemplate: '{version}/manifest.json.sig',
          publicKeyUrl: 'https://downloads.claude.ai/keys/key.asc',
          publicKeyFingerprint: 'AABB CCDD',
          binaryPathTemplate: '{version}/{platform}/{binary}',
          platforms: { 'linux-x64': 'linux-x64' },
        },
      },
      versionCommand: { executable: 'bin/codex', args: ['-v'] },
    });

    expect(definition.managedInstall?.type).toBe('signed-binary-bucket');
    expect(Object.isFrozen(definition.managedInstall)).toBe(true);
  });
});
