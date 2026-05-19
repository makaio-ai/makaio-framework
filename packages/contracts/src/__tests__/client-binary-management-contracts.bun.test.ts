/**
 * Tests for client binary management request/response contract schemas.
 *
 * Covers the eight `client.*` subjects added for the managed-binary feature:
 * - `client.list`                (request/response)
 * - `client.install`             (request/response)
 * - `client.uninstall`           (request/response)
 * - `client.update`              (request/response)
 * - `client.setActive`           (request/response)
 * - `client.installJob.progress` (event)
 * - `client.installJob.completed`(event)
 * - `client.version.changed`     (event)
 * - `client.config.prime`        (request/response)
 */
import { describe, expect, it } from 'bun:test';
import {
  ClientConfigPrimeSchema,
  ClientInstallCompletedSchema,
  ClientInstallProgressSchema,
  ClientInstallSchema,
  ClientListSchema,
  ClientSetActiveSchema,
  ClientUninstallSchema,
  ClientUpdateSchema,
  ClientVersionChangedSchema,
  InstallStageSchema,
} from '@makaio/contracts/client';

// ---------------------------------------------------------------------------
// client.list
// ---------------------------------------------------------------------------

describe('client.list request', () => {
  it('accepts an empty request (no forceRefresh)', () => {
    const result = ClientListSchema.request.safeParse({});

    expect(result.success).toBe(true);
  });

  it('accepts forceRefresh: true', () => {
    const result = ClientListSchema.request.parse({ forceRefresh: true });

    expect(result.forceRefresh).toBe(true);
  });

  it('accepts forceRefresh: false', () => {
    const result = ClientListSchema.request.parse({ forceRefresh: false });

    expect(result.forceRefresh).toBe(false);
  });

  it('rejects non-boolean forceRefresh', () => {
    expect(ClientListSchema.request.safeParse({ forceRefresh: 'yes' }).success).toBe(false);
  });
});

describe('client.list response', () => {
  it('accepts a valid response with an empty clients array', () => {
    const result = ClientListSchema.response.parse({ clients: [] });

    expect(result.clients).toHaveLength(0);
  });

  it('accepts managed client list entries with pinnedVersion', () => {
    const result = ClientListSchema.response.parse({
      clients: [
        {
          clientId: 'codex',
          installedVersions: [
            {
              version: '0.130.0',
              installPath: '/home/user/.makaio/clients/codex/0.130.0',
              installedAt: 1_700_000_000_000,
              isActive: true,
            },
          ],
          activeVersion: '0.130.0',
          pinnedVersion: '0.130.0',
          updateAvailable: false,
        },
      ],
    });

    expect(result.clients[0]?.pinnedVersion).toBe('0.130.0');
  });

  it('accepts a full client entry with installed versions and pinnedVersion', () => {
    const result = ClientListSchema.response.parse({
      clients: [
        {
          clientId: 'claude-code',
          installedVersions: [
            {
              version: '1.2.3',
              installPath: '/home/user/.makaio/clients/claude-code/1.2.3',
              installedAt: 1_700_000_000_000,
              isActive: true,
            },
          ],
          activeVersion: '1.2.3',
          pinnedVersion: '1.3.0',
          updateAvailable: true,
        },
      ],
    });

    const [entry] = result.clients;

    expect(entry?.clientId).toBe('claude-code');
    expect(entry?.activeVersion).toBe('1.2.3');
    expect(entry?.pinnedVersion).toBe('1.3.0');
    expect(entry?.updateAvailable).toBe(true);
    expect(entry?.installedVersions[0]?.isActive).toBe(true);
  });

  it('accepts null activeVersion when no version is installed', () => {
    const result = ClientListSchema.response.parse({
      clients: [
        {
          clientId: 'claude-code',
          installedVersions: [],
          activeVersion: null,
          pinnedVersion: '1.0.0',
          updateAvailable: true,
        },
      ],
    });

    const [entry] = result.clients;

    expect(entry?.activeVersion).toBeNull();
    expect(entry?.pinnedVersion).toBe('1.0.0');
    expect(entry?.updateAvailable).toBe(true);
  });

  it('rejects removed upstream latest metadata in managed client list entries', () => {
    const result = ClientListSchema.response.safeParse({
      clients: [
        {
          clientId: 'codex',
          installedVersions: [],
          activeVersion: null,
          pinnedVersion: '0.130.0',
          updateAvailable: false,
          latestAvailableVersion: '0.130.0',
          latestVersionLastCheckedAt: Date.now(),
          latestVersionSourceStatus: 'fresh',
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects a client entry missing pinnedVersion', () => {
    expect(
      ClientListSchema.response.safeParse({
        clients: [
          {
            clientId: 'claude-code',
            installedVersions: [],
            activeVersion: null,
            updateAvailable: false,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects a non-semver pinnedVersion', () => {
    expect(
      ClientListSchema.response.safeParse({
        clients: [
          {
            clientId: 'claude-code',
            installedVersions: [],
            activeVersion: null,
            pinnedVersion: '^1.0.0',
            updateAvailable: false,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects a clientId that is blank or whitespace-only', () => {
    expect(
      ClientListSchema.response.safeParse({
        clients: [
          {
            clientId: '   ',
            installedVersions: [],
            activeVersion: null,
            pinnedVersion: '1.0.0',
            updateAvailable: false,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects a missing clients array', () => {
    expect(ClientListSchema.response.safeParse({}).success).toBe(false);
  });

  it('rejects an installedVersions entry with a relative installPath', () => {
    expect(
      ClientListSchema.response.safeParse({
        clients: [
          {
            clientId: 'claude-code',
            installedVersions: [
              {
                version: '1.2.3',
                installPath: 'relative/path/claude-code/1.2.3',
                installedAt: 1_700_000_000_000,
                isActive: true,
              },
            ],
            activeVersion: '1.2.3',
            pinnedVersion: '1.2.3',
            updateAvailable: false,
          },
        ],
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// client.install
// ---------------------------------------------------------------------------

describe('client.install request', () => {
  it('accepts a request with only clientId', () => {
    const result = ClientInstallSchema.request.parse({ clientId: 'claude-code' });

    expect(result.clientId).toBe('claude-code');
    expect(result.version).toBeUndefined();
  });

  it('accepts a request with a specific version', () => {
    const result = ClientInstallSchema.request.parse({
      clientId: 'claude-code',
      version: '1.2.3',
    });

    expect(result.version).toBe('1.2.3');
  });

  it('rejects an empty clientId', () => {
    expect(ClientInstallSchema.request.safeParse({ clientId: '' }).success).toBe(false);
  });

  it('rejects an empty version string (version must be non-empty when present)', () => {
    expect(ClientInstallSchema.request.safeParse({ clientId: 'claude-code', version: '' }).success).toBe(false);
  });
});

describe('client.install response', () => {
  it('accepts a response with null resolvedVersion', () => {
    const result = ClientInstallSchema.response.parse({
      jobId: 'job-001',
      requestedVersion: '1.2.3',
      resolvedVersion: null,
    });

    expect(result.jobId).toBe('job-001');
    expect(result.resolvedVersion).toBeNull();
  });

  it('accepts a fully resolved response', () => {
    const result = ClientInstallSchema.response.parse({
      jobId: 'job-002',
      requestedVersion: null,
      resolvedVersion: '1.3.0',
    });

    expect(result.requestedVersion).toBeNull();
    expect(result.resolvedVersion).toBe('1.3.0');
  });

  it('rejects an empty jobId', () => {
    expect(
      ClientInstallSchema.response.safeParse({
        jobId: '',
        requestedVersion: null,
        resolvedVersion: null,
      }).success,
    ).toBe(false);
  });

  it('rejects an empty requestedVersion string (must be non-empty or null)', () => {
    expect(
      ClientInstallSchema.response.safeParse({
        jobId: 'job-001',
        requestedVersion: '',
        resolvedVersion: null,
      }).success,
    ).toBe(false);
  });

  it('rejects an empty resolvedVersion string (must be non-empty or null)', () => {
    expect(
      ClientInstallSchema.response.safeParse({
        jobId: 'job-001',
        requestedVersion: null,
        resolvedVersion: '',
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// client.uninstall
// ---------------------------------------------------------------------------

describe('client.uninstall request', () => {
  it('accepts a valid request', () => {
    const result = ClientUninstallSchema.request.parse({
      clientId: 'claude-code',
      version: '1.0.0',
    });

    expect(result.version).toBe('1.0.0');
  });

  it('rejects an empty version string', () => {
    expect(ClientUninstallSchema.request.safeParse({ clientId: 'claude-code', version: '' }).success).toBe(false);
  });
});

describe('client.uninstall response', () => {
  it('accepts null activeVersion after removing the last installed version', () => {
    const result = ClientUninstallSchema.response.parse({
      clientId: 'claude-code',
      removedVersion: '1.0.0',
      activeVersion: null,
    });

    expect(result.activeVersion).toBeNull();
  });

  it('accepts a response where another version remains active', () => {
    const result = ClientUninstallSchema.response.parse({
      clientId: 'claude-code',
      removedVersion: '1.0.0',
      activeVersion: '0.9.0',
    });

    expect(result.activeVersion).toBe('0.9.0');
  });
});

// ---------------------------------------------------------------------------
// client.update
// ---------------------------------------------------------------------------

describe('client.update request', () => {
  it('accepts a valid request', () => {
    const result = ClientUpdateSchema.request.parse({ clientId: 'claude-code' });

    expect(result.clientId).toBe('claude-code');
  });

  it('rejects a blank clientId', () => {
    expect(ClientUpdateSchema.request.safeParse({ clientId: ' ' }).success).toBe(false);
  });
});

describe('client.update response', () => {
  it('accepts a null resolvedVersion when resolution is deferred', () => {
    const result = ClientUpdateSchema.response.parse({
      jobId: 'job-update-01',
      resolvedVersion: null,
    });

    expect(result.resolvedVersion).toBeNull();
  });

  it('accepts a populated resolvedVersion', () => {
    const result = ClientUpdateSchema.response.parse({
      jobId: 'job-update-02',
      resolvedVersion: '1.5.0',
    });

    expect(result.resolvedVersion).toBe('1.5.0');
  });
});

// ---------------------------------------------------------------------------
// client.setActive
// ---------------------------------------------------------------------------

describe('client.setActive request', () => {
  it('accepts a valid request', () => {
    const result = ClientSetActiveSchema.request.parse({
      clientId: 'claude-code',
      version: '1.2.3',
    });

    expect(result.version).toBe('1.2.3');
  });

  it('rejects an empty version', () => {
    expect(ClientSetActiveSchema.request.safeParse({ clientId: 'claude-code', version: '' }).success).toBe(false);
  });
});

describe('client.setActive response', () => {
  it('accepts a valid response', () => {
    const result = ClientSetActiveSchema.response.parse({
      clientId: 'claude-code',
      activeVersion: '1.2.3',
    });

    expect(result.activeVersion).toBe('1.2.3');
  });

  it('rejects an empty activeVersion', () => {
    expect(
      ClientSetActiveSchema.response.safeParse({
        clientId: 'claude-code',
        activeVersion: '',
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// client.installJob.progress (event)
// ---------------------------------------------------------------------------

describe('client.installJob.progress', () => {
  it('accepts a progress event with a numeric progress value', () => {
    const result = ClientInstallProgressSchema.parse({
      jobId: 'job-003',
      clientId: 'claude-code',
      version: '1.2.3',
      strategy: 'signed-binary-bucket',
      stage: 'downloading',
      progress: 42.5,
    });

    expect(result.stage).toBe('downloading');
    expect(result.progress).toBe(42.5);
  });

  it('accepts a progress event with null progress (stage does not report progress)', () => {
    const result = ClientInstallProgressSchema.parse({
      jobId: 'job-003',
      clientId: 'claude-code',
      version: '1.2.3',
      strategy: 'npm',
      stage: 'resolving',
      progress: null,
    });

    expect(result.progress).toBeNull();
  });

  it('accepts optional fields: installPath, activeAfterCompletion, metadata', () => {
    const result = ClientInstallProgressSchema.parse({
      jobId: 'job-004',
      clientId: 'claude-code',
      version: '1.2.3',
      strategy: 'signed-binary-bucket',
      stage: 'installing',
      progress: 100,
      installPath: '/opt/makaio/clients/claude-code/1.2.3',
      activeAfterCompletion: true,
      metadata: { assetName: 'claude-darwin-arm64.tar.gz' },
    });

    expect(result.installPath).toBe('/opt/makaio/clients/claude-code/1.2.3');
    expect(result.activeAfterCompletion).toBe(true);
    expect(result.metadata?.['assetName']).toBe('claude-darwin-arm64.tar.gz');
  });

  it('accepts a progress event without version (resolving stage, version not yet known)', () => {
    const result = ClientInstallProgressSchema.parse({
      jobId: 'job-003',
      clientId: 'claude-code',
      strategy: 'npm',
      stage: 'resolving',
      progress: null,
    });

    expect(result.version).toBeUndefined();
  });

  it('rejects an empty version string', () => {
    expect(
      ClientInstallProgressSchema.safeParse({
        jobId: 'job-003',
        clientId: 'claude-code',
        version: '',
        strategy: 'npm',
        stage: 'downloading',
        progress: null,
      }).success,
    ).toBe(false);
  });

  it('rejects an empty installPath string', () => {
    expect(
      ClientInstallProgressSchema.safeParse({
        jobId: 'job-003',
        clientId: 'claude-code',
        version: '1.2.3',
        strategy: 'npm',
        stage: 'installing',
        progress: 50,
        installPath: '',
      }).success,
    ).toBe(false);
  });

  it('rejects a relative installPath (must be absolute)', () => {
    expect(
      ClientInstallProgressSchema.safeParse({
        jobId: 'job-003',
        clientId: 'claude-code',
        version: '1.2.3',
        strategy: 'npm',
        stage: 'installing',
        progress: 50,
        installPath: 'relative/path/to/binary',
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid stage value', () => {
    expect(
      ClientInstallProgressSchema.safeParse({
        jobId: 'job-003',
        clientId: 'claude-code',
        version: '1.2.3',
        strategy: 'npm',
        stage: 'rolling-back',
        progress: null,
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid strategy value', () => {
    expect(
      ClientInstallProgressSchema.safeParse({
        jobId: 'job-003',
        clientId: 'claude-code',
        version: '1.2.3',
        strategy: 'custom-bucket',
        stage: 'downloading',
        progress: 10,
      }).success,
    ).toBe(false);
  });

  it('rejects progress values outside the [0, 100] range', () => {
    expect(
      ClientInstallProgressSchema.safeParse({
        jobId: 'job-003',
        clientId: 'claude-code',
        version: '1.2.3',
        strategy: 'npm',
        stage: 'downloading',
        progress: 101,
      }).success,
    ).toBe(false);

    expect(
      ClientInstallProgressSchema.safeParse({
        jobId: 'job-003',
        clientId: 'claude-code',
        version: '1.2.3',
        strategy: 'npm',
        stage: 'downloading',
        progress: -1,
      }).success,
    ).toBe(false);
  });

  it('validates every InstallStageSchema member', () => {
    const stages = InstallStageSchema.options;
    expect(stages).toEqual([
      'resolving',
      'downloading',
      'verifying',
      'extracting',
      'installing',
      'post-install',
      'activating',
    ]);

    for (const stage of stages) {
      expect(
        ClientInstallProgressSchema.safeParse({
          jobId: 'job-stage-test',
          clientId: 'claude-code',
          version: '1.0.0',
          strategy: 'npm',
          stage,
          progress: null,
        }).success,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// client.installJob.completed (event)
// ---------------------------------------------------------------------------

describe('client.installJob.completed', () => {
  it('accepts a success completion without error', () => {
    const result = ClientInstallCompletedSchema.parse({
      jobId: 'job-005',
      clientId: 'claude-code',
      version: '1.2.3',
      strategy: 'signed-binary-bucket',
      status: 'success',
      installPath: '/opt/makaio/clients/claude-code/1.2.3',
      activeVersion: '1.2.3',
    });

    expect(result.status).toBe('success');
    expect(result.error).toBeUndefined();
  });

  it('accepts an error completion with error details', () => {
    const result = ClientInstallCompletedSchema.parse({
      jobId: 'job-006',
      clientId: 'claude-code',
      version: '1.2.3',
      strategy: 'signed-binary-bucket',
      status: 'error',
      activeVersion: null,
      error: { message: 'Download failed', code: 'ECONNRESET' },
    });

    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('Download failed');
    expect(result.error?.code).toBe('ECONNRESET');
    expect(result.activeVersion).toBeNull();
  });

  it('accepts error without a code field', () => {
    const result = ClientInstallCompletedSchema.parse({
      jobId: 'job-007',
      clientId: 'claude-code',
      version: '1.2.3',
      strategy: 'npm',
      status: 'error',
      activeVersion: null,
      error: { message: 'npm exited with code 1' },
    });

    expect(result.error?.code).toBeUndefined();
  });

  it('accepts optional metadata on success', () => {
    const result = ClientInstallCompletedSchema.parse({
      jobId: 'job-008',
      clientId: 'claude-code',
      version: '1.2.3',
      strategy: 'npm',
      status: 'success',
      activeVersion: '1.2.3',
      metadata: { durationMs: 4200 },
    });

    expect(result.metadata?.['durationMs']).toBe(4200);
  });

  it('accepts a completed event without version (failed before resolution)', () => {
    const result = ClientInstallCompletedSchema.parse({
      jobId: 'job-009',
      clientId: 'claude-code',
      strategy: 'npm',
      status: 'error',
      activeVersion: null,
      error: { message: 'Resolution failed' },
    });

    expect(result.version).toBeUndefined();
  });

  it('rejects an empty version string', () => {
    expect(
      ClientInstallCompletedSchema.safeParse({
        jobId: 'job-009',
        clientId: 'claude-code',
        version: '',
        strategy: 'npm',
        status: 'error',
        activeVersion: null,
      }).success,
    ).toBe(false);
  });

  it('rejects an empty installPath string', () => {
    expect(
      ClientInstallCompletedSchema.safeParse({
        jobId: 'job-009',
        clientId: 'claude-code',
        version: '1.2.3',
        strategy: 'npm',
        status: 'success',
        activeVersion: '1.2.3',
        installPath: '',
      }).success,
    ).toBe(false);
  });

  it('rejects a relative installPath (must be absolute)', () => {
    expect(
      ClientInstallCompletedSchema.safeParse({
        jobId: 'job-009',
        clientId: 'claude-code',
        version: '1.2.3',
        strategy: 'npm',
        status: 'success',
        activeVersion: '1.2.3',
        installPath: 'relative/clients/claude-code/1.2.3',
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid status value', () => {
    expect(
      ClientInstallCompletedSchema.safeParse({
        jobId: 'job-009',
        clientId: 'claude-code',
        version: '1.2.3',
        strategy: 'npm',
        status: 'cancelled',
        activeVersion: null,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// client.version.changed (event)
// ---------------------------------------------------------------------------

describe('client.version.changed', () => {
  it('accepts a version change caused by install', () => {
    const result = ClientVersionChangedSchema.parse({
      clientId: 'claude-code',
      previousActiveVersion: null,
      activeVersion: '1.0.0',
      reason: 'install',
    });

    expect(result.previousActiveVersion).toBeNull();
    expect(result.activeVersion).toBe('1.0.0');
    expect(result.reason).toBe('install');
  });

  it('accepts all four reason values', () => {
    const reasons = ['install', 'update', 'set-active', 'uninstall'] as const;

    for (const reason of reasons) {
      expect(
        ClientVersionChangedSchema.safeParse({
          clientId: 'claude-code',
          previousActiveVersion: '0.9.0',
          activeVersion: reason === 'uninstall' ? null : '1.0.0',
          reason,
        }).success,
      ).toBe(true);
    }
  });

  it('accepts null for both version fields (no-op clear)', () => {
    const result = ClientVersionChangedSchema.parse({
      clientId: 'claude-code',
      previousActiveVersion: null,
      activeVersion: null,
      reason: 'uninstall',
    });

    expect(result.previousActiveVersion).toBeNull();
    expect(result.activeVersion).toBeNull();
  });

  it('rejects an invalid reason value', () => {
    expect(
      ClientVersionChangedSchema.safeParse({
        clientId: 'claude-code',
        previousActiveVersion: null,
        activeVersion: '1.0.0',
        reason: 'rollback',
      }).success,
    ).toBe(false);
  });

  it('rejects a blank clientId', () => {
    expect(
      ClientVersionChangedSchema.safeParse({
        clientId: '',
        previousActiveVersion: null,
        activeVersion: '1.0.0',
        reason: 'install',
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// client.config.prime (request/response)
// ---------------------------------------------------------------------------

describe('client.config.prime', () => {
  it('accepts client.config.prime requests for managed-install phase', () => {
    const result = ClientConfigPrimeSchema.request.parse({
      clientId: 'claude-code',
      configDir: '/tmp/makaio/clients/claude-code/config',
      phase: 'managed-install',
      binaryVersion: '2.1.143',
    });

    expect(result.phase).toBe('managed-install');
    expect(result.binaryVersion).toBe('2.1.143');
  });

  it('accepts client.config.prime requests with adapterName for session-create phase', () => {
    const result = ClientConfigPrimeSchema.request.parse({
      clientId: 'codex',
      configDir: '/tmp/makaio/clients/codex/sessions/session-1',
      phase: 'session-create',
      binaryVersion: '0.130.0',
      adapterName: 'codex-app-server',
      projectDir: '/tmp/project',
    });

    expect(result.adapterName).toBe('codex-app-server');
    expect(result.projectDir).toBe('/tmp/project');
  });

  it('accepts a profile-create request without binaryVersion or adapterName', () => {
    const result = ClientConfigPrimeSchema.request.parse({
      clientId: 'claude-code',
      configDir: '/tmp/makaio/clients/claude-code/profiles/work',
      phase: 'profile-create',
    });

    expect(result.phase).toBe('profile-create');
    expect(result.binaryVersion).toBeUndefined();
    expect(result.adapterName).toBeUndefined();
  });

  it('rejects a request with a relative configDir', () => {
    expect(
      ClientConfigPrimeSchema.request.safeParse({
        clientId: 'claude-code',
        configDir: 'relative/path/to/config',
        phase: 'managed-install',
      }).success,
    ).toBe(false);
  });

  it('rejects a request with an empty clientId', () => {
    expect(
      ClientConfigPrimeSchema.request.safeParse({
        clientId: '',
        configDir: '/tmp/makaio/config',
        phase: 'managed-install',
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid phase value', () => {
    expect(
      ClientConfigPrimeSchema.request.safeParse({
        clientId: 'claude-code',
        configDir: '/tmp/makaio/config',
        phase: 'pre-install',
      }).success,
    ).toBe(false);
  });

  it('rejects a non-semver binaryVersion', () => {
    expect(
      ClientConfigPrimeSchema.request.safeParse({
        clientId: 'claude-code',
        configDir: '/tmp/makaio/config',
        phase: 'managed-install',
        binaryVersion: '^2.0.0',
      }).success,
    ).toBe(false);
  });

  it('accepts a response with primed:true', () => {
    const result = ClientConfigPrimeSchema.response.parse({ primed: true });

    expect(result.primed).toBe(true);
  });

  it('accepts a response with primed:false (no handler registered)', () => {
    const result = ClientConfigPrimeSchema.response.parse({ primed: false });

    expect(result.primed).toBe(false);
  });
});
