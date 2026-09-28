/**
 * ToolApprovalService — .makaioignore pre-check integration tests.
 *
 * Verifies that a FileAccessRuleProvider wired into ToolApprovalService acts as
 * an absolute deny layer that runs before the policy cascade. Even a full-access
 * policy cannot bypass a path denied by the provider.
 *
 * Uses a lightweight inline provider so these tests are independent of the real
 * makaioignore file system. Tests use real bus handlers — no mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, ApprovalSubjects, HarnessSubjects } from '@makaio/contracts';
import { extractToolFilePath, type FileAccessRuleProvider } from '@makaio/tools-core';
import { AgentStorageSubjects } from '../../session/index.js';
import { ToolApprovalService } from '../tool-approval-service.js';
import {
  createToolApprovePayload,
  registerDefaultHarnessHandler,
  registerAgentStub,
  registerSessionStorageHandler,
  TEST_ADAPTER_NAME,
} from './test-utils.js';

// Test provider: denies any path ending in '.env' or containing '.ssh'.
const testProvider: FileAccessRuleProvider = async (_cwd, allowedDirs) => ({
  ...(allowedDirs !== undefined && { allowedDirectories: [...allowedDirs] }),
  isDenied: (p) => p.endsWith('.env') || p.includes('.ssh'),
});

const TEST_CWD = '/home/user/project';

const NO_CWD_REASON = 'Access denied: file access rules could not be evaluated: agent has no working directory';

/**
 * Send a toolApprove request for one tool call.
 * @param toolName - Tool name of the call
 * @param args - Tool call input
 * @returns Approval response
 */
function approve(toolName: string, args: Record<string, unknown>) {
  return MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload({ toolName, args }));
}

/**
 * Assert that the file-access pre-check did not deny the call; the cascade may still deny it.
 * @param result - Approval response
 */
function expectNotDeniedByFileAccess(result: Awaited<ReturnType<typeof approve>>): void {
  if (result.action === 'deny') {
    expect(result.message).not.toContain('.makaioignore');
    expect(result.message).not.toContain('could not be evaluated');
  }
}

describe('ToolApprovalService - .makaioignore pre-check', () => {
  let service: ToolApprovalService;
  const cleanups: Array<() => void> = [];

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    service = new ToolApprovalService(MakaioBus, { fileAccessRuleProvider: testProvider });
    cleanups.push(registerDefaultHarnessHandler());
    await service.init();
  });

  afterEach(() => {
    service.destroy();
    cleanups.forEach((fn) => fn());
    cleanups.length = 0;
    MakaioBus.__resetHandlers?.();
  });

  it('denies read_file on a .env path with a .makaioignore message', async () => {
    registerAgentStub(cleanups, { cwd: TEST_CWD });

    const result = await MakaioBus.request(
      AgentSubjects.toolApprove,
      createToolApprovePayload({
        toolName: 'read_file',
        args: { path: `${TEST_CWD}/.env` },
      }),
    );

    expect(result.action).toBe('deny');
    if (result.action === 'deny') {
      expect(result.message).toContain('.makaioignore');
      expect(result.shouldAbort).toBe(false);
    }
  });

  it('does NOT pre-check deny read_file on an allowed path', async () => {
    registerAgentStub(cleanups, { cwd: TEST_CWD });

    // With no ApprovalSubjects.request handler and 'always-ask' policy the
    // service will fall through to 'No approval handler available' — that is
    // fine; what matters is that the pre-check does NOT deny it.
    const result = await MakaioBus.request(
      AgentSubjects.toolApprove,
      createToolApprovePayload({
        toolName: 'read_file',
        args: { path: `${TEST_CWD}/readme.txt` },
      }),
    );

    // The pre-check must not have blocked this path. The result may still be
    // 'deny' from the approval cascade (no handler registered), but the message
    // must NOT contain '.makaioignore'.
    if (result.action === 'deny') {
      expect(result.message).not.toContain('.makaioignore');
    }
  });

  it('denies Write on a path containing .ssh', async () => {
    registerAgentStub(cleanups, { cwd: TEST_CWD });

    const result = await MakaioBus.request(
      AgentSubjects.toolApprove,
      createToolApprovePayload({
        toolName: 'Write',
        args: { file_path: `/home/user/.ssh/authorized_keys` },
      }),
    );

    expect(result.action).toBe('deny');
    if (result.action === 'deny') {
      expect(result.message).toContain('.makaioignore');
      expect(result.shouldAbort).toBe(false);
    }
  });

  it('skips the pre-check for an unknown tool (bash) and does not deny via .makaioignore', async () => {
    registerAgentStub(cleanups, { cwd: TEST_CWD });

    const result = await MakaioBus.request(
      AgentSubjects.toolApprove,
      createToolApprovePayload({
        toolName: 'bash',
        args: { command: 'cat .env' },
      }),
    );

    // bash is not a filesystem tool — extractToolFilePath returns null, so the
    // pre-check is skipped entirely. The message (if deny) must not reference
    // .makaioignore rules.
    if (result.action === 'deny') {
      expect(result.message).not.toContain('.makaioignore');
    }
  });

  it('pre-check fires before full-access auto-allow and denies a .env path', async () => {
    // Register a harness that returns full-access — without the pre-check this
    // would auto-allow immediately without consulting approval handlers.
    // Priority 1 ensures this handler wins over the beforeEach default (priority 0).
    cleanups.push(
      MakaioBus.on(
        HarnessSubjects.resolve,
        (ctx) => {
          ctx.setResult({
            id: 'full-access-harness',
            name: 'full-access',
            description: 'Full-access test harness',
            adapterName: TEST_ADAPTER_NAME,
            approvalPolicy: 'full-access',
            nativeTools: { enabled: [], disabled: [] },
            registryTools: { enabled: [], disabled: [] },
            isDefault: true,
            enabled: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        },
        { priority: 1 },
      ),
    );
    registerAgentStub(cleanups, { cwd: TEST_CWD });

    const result = await MakaioBus.request(
      AgentSubjects.toolApprove,
      createToolApprovePayload({
        toolName: 'read_file',
        args: { path: `${TEST_CWD}/.env` },
      }),
    );

    // The pre-check must fire before the full-access auto-allow.
    expect(result.action).toBe('deny');
    if (result.action === 'deny') {
      expect(result.message).toContain('.makaioignore');
      expect(result.shouldAbort).toBe(false);
    }
  });

  it('passes allowedDirectories from enriched-policy RPC to the file access provider', async () => {
    const profileAllowedDirs = ['/home/user/project', '/tmp/workspace'];
    const capturedAllowedDirs: string[] = [];

    // Override the provider to capture what allowedDirectories it receives.
    service.destroy();
    service = new ToolApprovalService(MakaioBus, {
      fileAccessRuleProvider: async (_cwd, allowedDirs) => {
        capturedAllowedDirs.push(...(allowedDirs ?? []));
        return { isDenied: () => false };
      },
    });
    await service.init();

    // Agent has a profileId — enriched-policy RPC will return allowedDirectories.
    registerAgentStub(cleanups, { cwd: TEST_CWD, profileId: 'profile-with-dirs' });

    cleanups.push(
      MakaioBus.on(ApprovalSubjects.resolveEnrichedPolicy, (ctx) => {
        ctx.setResult({ action: 'ask', allowedDirectories: profileAllowedDirs });
      }),
    );

    await MakaioBus.request(
      AgentSubjects.toolApprove,
      createToolApprovePayload({
        toolName: 'read_file',
        args: { path: `${TEST_CWD}/readme.txt` },
      }),
    );

    expect(capturedAllowedDirs).toEqual(profileAllowedDirs);
  });

  it('denies with deterministic message when file rule evaluation fails', async () => {
    service.destroy();
    service = new ToolApprovalService(MakaioBus, {
      fileAccessRuleProvider: async () => {
        throw new Error('provider unavailable');
      },
    });
    await service.init();

    registerAgentStub(cleanups, { cwd: TEST_CWD });

    const result = await MakaioBus.request(
      AgentSubjects.toolApprove,
      createToolApprovePayload({
        toolName: 'read_file',
        args: { path: `${TEST_CWD}/readme.txt` },
      }),
    );

    expect(result.action).toBe('deny');
    if (result.action === 'deny') {
      expect(result.message).toBe('Access denied: file access rules could not be evaluated');
      expect(result.shouldAbort).toBe(false);
    }
  });

  describe('agent without a working directory', () => {
    it('denies Edit on a path when the agent row has no cwd', async () => {
      registerAgentStub(cleanups);

      const result = await approve('Edit', { file_path: `${TEST_CWD}/readme.txt` });

      expect(result).toEqual({ action: 'deny', message: NO_CWD_REASON, shouldAbort: false });
    });

    it('denies Edit on a path when no agent row exists', async () => {
      cleanups.push(
        MakaioBus.on(AgentStorageSubjects.listBySession, (ctx) => {
          ctx.setResult({ agents: [] });
        }),
      );

      const result = await approve('Edit', { file_path: `${TEST_CWD}/readme.txt` });

      expect(result).toEqual({ action: 'deny', message: NO_CWD_REASON, shouldAbort: false });
    });

    it('keeps the no-cwd deny ahead of a full-access session override', async () => {
      registerAgentStub(cleanups);
      registerSessionStorageHandler(cleanups, 'full-access');

      const result = await approve('Write', { file_path: `${TEST_CWD}/out.txt` });

      expect(result).toEqual({ action: 'deny', message: NO_CWD_REASON, shouldAbort: false });
    });

    it('does not deny a Glob call without path when the agent row has no cwd', async () => {
      registerAgentStub(cleanups);

      expectNotDeniedByFileAccess(await approve('Glob', { pattern: '**/*.ts' }));
    });

    it('leaves a row without cwd to the cascade when no provider is configured', async () => {
      service.destroy();
      service = new ToolApprovalService(MakaioBus);
      await service.init();
      registerAgentStub(cleanups);

      const result = await approve('Edit', { file_path: `${TEST_CWD}/.env` });

      // Default harness is always-ask and no approval handler is registered.
      expect(result).toEqual({ action: 'deny', message: 'No approval handler available', shouldAbort: false });
    });
  });

  describe('Claude search and notebook tools', () => {
    const gitDenyingProvider: FileAccessRuleProvider = async () => ({
      isDenied: (p) => p.split('/').includes('.git'),
    });

    beforeEach(async () => {
      service.destroy();
      service = new ToolApprovalService(MakaioBus, { fileAccessRuleProvider: gitDenyingProvider });
      await service.init();
      registerAgentStub(cleanups, { cwd: TEST_CWD });
    });

    it('denies Grep with a path inside a denied directory', async () => {
      const result = await approve('Grep', { pattern: 'token', path: '.git' });

      expect(result.action).toBe('deny');
      if (result.action === 'deny') {
        expect(result.message).toBe(`Access denied: '${TEST_CWD}/.git' is restricted by .makaioignore rules`);
      }
    });

    it('does not deny Glob or Grep without a path via the file-access check', async () => {
      expectNotDeniedByFileAccess(await approve('Glob', { pattern: '**/*.ts' }));
      expectNotDeniedByFileAccess(await approve('Grep', { pattern: 'token' }));
    });

    it('denies NotebookEdit on a notebook inside a denied directory', async () => {
      const result = await approve('NotebookEdit', { notebook_path: '.git/notes.ipynb', new_source: '' });

      expect(result.action).toBe('deny');
      if (result.action === 'deny') expect(result.message).toContain('.makaioignore');
    });

    it('extracts the search and notebook target paths', () => {
      expect(extractToolFilePath('NotebookEdit', { notebook_path: 'nb/a.ipynb' }, TEST_CWD)).toBe(
        `${TEST_CWD}/nb/a.ipynb`,
      );
      expect(extractToolFilePath('Grep', { pattern: 'x', path: 'src' }, TEST_CWD)).toBe(`${TEST_CWD}/src`);
      expect(extractToolFilePath('Glob', { pattern: '**/*' }, TEST_CWD)).toBeNull();
    });
  });
});
