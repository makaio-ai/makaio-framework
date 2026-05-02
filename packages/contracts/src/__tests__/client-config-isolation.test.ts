/**
 * Tests for `configIsolation` on `ClientDefinitionSchema` and for the
 * `client.resolveBinary` bus schema contracts.
 *
 * Verifies that:
 * - `configIsolation` parses successfully when provided with valid fields.
 * - `configIsolation` is optional on any definition, regardless of
 *   `supportsManagedBinary`.
 * - `configIsolation.envVar` and `configIsolation.defaultPath` reject empty
 *   strings.
 * - `configIsolation.pathKind` distinguishes directory and file env targets.
 * - `ClientResolveBinarySchema.request` parses minimal and full inputs.
 * - `ClientExecutionContextSchema` parses managed and global contexts.
 */
import { describe, expect, it } from 'vitest';
import { ClientDefinitionSchema, ConfigIsolationSchema, type ClientDefinitionInput } from '@makaio/contracts/client';
import { ClientExecutionContextSchema, ClientResolveBinarySchema } from '@makaio/contracts/client';

// ---------------------------------------------------------------------------
// Shared fixture helper
// ---------------------------------------------------------------------------

function makeMinimalInput(overrides?: Partial<ClientDefinitionInput>): ClientDefinitionInput {
  return {
    id: 'example-client',
    name: 'Example Client',
    defaultApprovalPolicy: 'always-ask',
    ...overrides,
  };
}

const NPM_MANAGED_INSTALL = {
  type: 'npm',
  package: '@example/test-client',
} as const;

// ---------------------------------------------------------------------------
// ConfigIsolationSchema
// ---------------------------------------------------------------------------

describe('ConfigIsolationSchema', () => {
  it('parses a valid config isolation object', () => {
    const result = ConfigIsolationSchema.parse({
      envVar: 'EXAMPLE_CONFIG_DIR',
      defaultPath: '~/.example-client',
    });

    expect(result.envVar).toBe('EXAMPLE_CONFIG_DIR');
    expect(result.defaultPath).toBe('~/.example-client');
    expect(result.pathKind).toBe('directory');
  });

  it('parses a file-target config isolation object', () => {
    const result = ConfigIsolationSchema.parse({
      envVar: 'QWEN_CODE_SYSTEM_DEFAULTS_PATH',
      defaultPath: '/etc/qwen-code/system-defaults.json',
      pathKind: 'file',
    });

    expect(result.pathKind).toBe('file');
  });

  it('rejects an empty envVar', () => {
    expect(ConfigIsolationSchema.safeParse({ envVar: '', defaultPath: '~/.example-client' }).success).toBe(false);
  });

  it('rejects a whitespace-only envVar', () => {
    expect(ConfigIsolationSchema.safeParse({ envVar: '   ', defaultPath: '~/.example-client' }).success).toBe(false);
  });

  it('rejects an empty defaultPath', () => {
    expect(ConfigIsolationSchema.safeParse({ envVar: 'EXAMPLE_CONFIG_DIR', defaultPath: '' }).success).toBe(false);
  });

  it('rejects a whitespace-only defaultPath', () => {
    expect(ConfigIsolationSchema.safeParse({ envVar: 'EXAMPLE_CONFIG_DIR', defaultPath: '   ' }).success).toBe(false);
  });

  it('rejects a relative defaultPath', () => {
    expect(ConfigIsolationSchema.safeParse({ envVar: 'EXAMPLE_CONFIG_DIR', defaultPath: 'config/myapp' }).success).toBe(
      false,
    );
  });

  it('accepts a bare tilde defaultPath', () => {
    const result = ConfigIsolationSchema.safeParse({ envVar: 'EXAMPLE_CONFIG_DIR', defaultPath: '~' });
    expect(result.success).toBe(true);
  });

  it('accepts an absolute defaultPath', () => {
    const result = ConfigIsolationSchema.safeParse({
      envVar: 'EXAMPLE_CONFIG_DIR',
      defaultPath: '/home/user/.example-client',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a Windows drive-letter absolute defaultPath on any host OS', () => {
    const result = ConfigIsolationSchema.safeParse({
      envVar: 'EXAMPLE_CONFIG_DIR',
      defaultPath: 'C:\\Users\\alice\\.example-client',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a Windows UNC absolute defaultPath on any host OS', () => {
    const result = ConfigIsolationSchema.safeParse({
      envVar: 'EXAMPLE_CONFIG_DIR',
      defaultPath: '\\\\server\\share\\.example-client',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a Windows rooted absolute defaultPath on any host OS', () => {
    const result = ConfigIsolationSchema.safeParse({
      envVar: 'EXAMPLE_CONFIG_DIR',
      defaultPath: '\\Users\\alice\\.example-client',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a Windows drive-relative defaultPath', () => {
    expect(
      ConfigIsolationSchema.safeParse({ envVar: 'EXAMPLE_CONFIG_DIR', defaultPath: 'C:relative\\.example-client' })
        .success,
    ).toBe(false);
  });

  it('rejects an envVar with shell metacharacters', () => {
    expect(
      ConfigIsolationSchema.safeParse({ envVar: 'EXAMPLE-CONFIG-DIR', defaultPath: '~/.example-client' }).success,
    ).toBe(false);
  });

  it('rejects an envVar starting with a digit', () => {
    expect(
      ConfigIsolationSchema.safeParse({ envVar: '1EXAMPLE_CONFIG_DIR', defaultPath: '~/.example-client' }).success,
    ).toBe(false);
  });

  it('rejects an envVar with dotted segments', () => {
    expect(
      ConfigIsolationSchema.safeParse({ envVar: 'EXAMPLE.CONFIG.DIR', defaultPath: '~/.example-client' }).success,
    ).toBe(false);
  });

  it('accepts an envVar starting with an underscore', () => {
    const result = ConfigIsolationSchema.safeParse({ envVar: '_EXAMPLE_CONFIG_DIR', defaultPath: '~/.example-client' });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid pathKind', () => {
    expect(
      ConfigIsolationSchema.safeParse({
        envVar: 'EXAMPLE_CONFIG_DIR',
        defaultPath: '~/.example-client',
        pathKind: 'socket',
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClientDefinitionSchema — configIsolation field
// ---------------------------------------------------------------------------

describe('ClientDefinitionSchema — configIsolation', () => {
  it('parses a definition with supportsManagedBinary: true and configIsolation', () => {
    const result = ClientDefinitionSchema.parse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: NPM_MANAGED_INSTALL,
        versionCommand: ['bin/example-client', '--version'],
        configIsolation: { envVar: 'EXAMPLE_CONFIG_DIR', defaultPath: '~/.example-client' },
      }),
    );

    expect(result.configIsolation?.envVar).toBe('EXAMPLE_CONFIG_DIR');
    expect(result.configIsolation?.defaultPath).toBe('~/.example-client');
  });

  it('parses a definition with supportsManagedBinary: true and no configIsolation (field is optional)', () => {
    const result = ClientDefinitionSchema.parse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: true },
        managedInstall: NPM_MANAGED_INSTALL,
        versionCommand: ['bin/example-client', '--version'],
      }),
    );

    expect(result.configIsolation).toBeUndefined();
  });

  it('parses a definition with supportsManagedBinary: false and configIsolation', () => {
    const result = ClientDefinitionSchema.parse(
      makeMinimalInput({
        runtimeCapabilities: { supportsManagedBinary: false },
        configIsolation: { envVar: 'CODEX_HOME', defaultPath: '~/.codex' },
      }),
    );

    expect(result.configIsolation?.envVar).toBe('CODEX_HOME');
    expect(result.configIsolation?.defaultPath).toBe('~/.codex');
  });

  it('parses a definition without runtimeCapabilities and with configIsolation (global binary)', () => {
    const result = ClientDefinitionSchema.parse(
      makeMinimalInput({
        configIsolation: { envVar: 'CODEX_HOME', defaultPath: '~/.codex' },
      }),
    );

    expect(result.configIsolation?.envVar).toBe('CODEX_HOME');
    expect(result.configIsolation?.defaultPath).toBe('~/.codex');
  });

  it('parses a definition without configIsolation (field is optional)', () => {
    const result = ClientDefinitionSchema.parse(makeMinimalInput());

    expect(result.configIsolation).toBeUndefined();
  });

  it('rejects a configIsolation with an empty envVar', () => {
    const result = ClientDefinitionSchema.safeParse(
      makeMinimalInput({
        configIsolation: { envVar: '', defaultPath: '~/.example-client' },
      }),
    );

    expect(result.success).toBe(false);
  });

  it('rejects a configIsolation with an empty defaultPath', () => {
    const result = ClientDefinitionSchema.safeParse(
      makeMinimalInput({
        configIsolation: { envVar: 'EXAMPLE_CONFIG_DIR', defaultPath: '' },
      }),
    );

    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClientResolveBinarySchema
// ---------------------------------------------------------------------------

describe('ClientResolveBinarySchema.request', () => {
  it('parses a minimal request with only clientId', () => {
    const result = ClientResolveBinarySchema.request.parse({ clientId: 'example-client' });

    expect(result.clientId).toBe('example-client');
    expect(result.sessionId).toBeUndefined();
    expect(result.projectDir).toBeUndefined();
    expect(result.preferSource).toBeUndefined();
    expect(result.harnessId).toBeUndefined();
  });

  it('parses a request with all Phase 2 optional fields', () => {
    const result = ClientResolveBinarySchema.request.parse({
      clientId: 'example-client',
      sessionId: 'session-abc-123',
      projectDir: '/Users/alice/my-project',
      preferSource: 'managed',
      harnessId: 'harness-xyz',
    });

    expect(result.clientId).toBe('example-client');
    expect(result.sessionId).toBe('session-abc-123');
    expect(result.projectDir).toBe('/Users/alice/my-project');
    expect(result.preferSource).toBe('managed');
    expect(result.harnessId).toBe('harness-xyz');
  });

  it('accepts preferSource: global', () => {
    const result = ClientResolveBinarySchema.request.parse({
      clientId: 'codex',
      preferSource: 'global',
    });

    expect(result.preferSource).toBe('global');
  });

  it('rejects an empty clientId', () => {
    expect(ClientResolveBinarySchema.request.safeParse({ clientId: '' }).success).toBe(false);
  });

  it('rejects a relative projectDir', () => {
    expect(
      ClientResolveBinarySchema.request.safeParse({
        clientId: 'example-client',
        projectDir: 'relative/path',
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid preferSource value', () => {
    expect(
      ClientResolveBinarySchema.request.safeParse({
        clientId: 'example-client',
        preferSource: 'local',
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClientExecutionContextSchema
// ---------------------------------------------------------------------------

describe('ClientExecutionContextSchema', () => {
  it('parses a managed context with env vars and a binary path', () => {
    const result = ClientExecutionContextSchema.parse({
      binaryPath: '/home/user/.makaio/clients/example-client/1.2.3/bin/example-client',
      env: { EXAMPLE_CONFIG_DIR: '/tmp/harness-abc/.example-client' },
      configDir: '/tmp/harness-abc/.example-client',
      source: 'managed',
      version: '1.2.3',
    });

    expect(result.binaryPath).toBe('/home/user/.makaio/clients/example-client/1.2.3/bin/example-client');
    expect(result.env['EXAMPLE_CONFIG_DIR']).toBe('/tmp/harness-abc/.example-client');
    expect(result.configDir).toBe('/tmp/harness-abc/.example-client');
    expect(result.source).toBe('managed');
    expect(result.version).toBe('1.2.3');
  });

  it('parses a global context with null binaryPath and null version', () => {
    const result = ClientExecutionContextSchema.parse({
      binaryPath: null,
      env: {},
      configDir: null,
      source: 'global',
      version: null,
    });

    expect(result.binaryPath).toBeNull();
    expect(result.env).toEqual({});
    expect(result.configDir).toBeNull();
    expect(result.source).toBe('global');
    expect(result.version).toBeNull();
  });

  it('parses a global context with a known configDir', () => {
    const result = ClientExecutionContextSchema.parse({
      binaryPath: null,
      env: {},
      configDir: '/Users/alice/.example-client',
      source: 'global',
      version: '2.0.0',
    });

    expect(result.configDir).toBe('/Users/alice/.example-client');
  });

  it('rejects an invalid source value', () => {
    expect(
      ClientExecutionContextSchema.safeParse({
        binaryPath: null,
        env: {},
        configDir: null,
        source: 'path',
        version: null,
      }).success,
    ).toBe(false);
  });

  it('rejects a relative binaryPath', () => {
    expect(
      ClientExecutionContextSchema.safeParse({
        binaryPath: 'bin/example-client',
        env: {},
        configDir: null,
        source: 'managed',
        version: '1.0.0',
      }).success,
    ).toBe(false);
  });

  it('rejects an empty version string', () => {
    expect(
      ClientExecutionContextSchema.safeParse({
        binaryPath: null,
        env: {},
        configDir: null,
        source: 'global',
        version: '',
      }).success,
    ).toBe(false);
  });
});
