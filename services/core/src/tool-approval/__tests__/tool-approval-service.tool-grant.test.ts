/**
 * ToolApprovalService — headless tool-list grant integration tests (FACT-73).
 *
 * The agent row carries `allowedTools` / `disallowedTools` in Makaio tool names;
 * toolApprove requests carry native Claude names. With an `always-ask` harness and
 * NO `ApprovalSubjects.request` handler (headless), a listed tool is allowed without
 * a human, an unlisted one is denied, and everything else still falls through to
 * "No approval handler available". Real bus handlers — no mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, HarnessSubjects } from '@makaio/contracts';
import type { FileAccessRuleProvider } from '@makaio/tools-core';
import { ToolApprovalService } from '../tool-approval-service.js';
import {
  createToolApprovePayload,
  registerAgentStub,
  registerDefaultHarnessHandler,
  registerSessionStorageHandler,
} from './test-utils.js';

const CLAUDE_ADAPTER = 'claude-code';
const TEST_CWD = '/home/user/project';
const NO_HANDLER = 'No approval handler available';

// Test provider: denies any path ending in '.env'.
const testProvider: FileAccessRuleProvider = async (_cwd, allowedDirs) => ({
  ...(allowedDirs !== undefined && { allowedDirectories: [...allowedDirs] }),
  isDenied: (p) => p.endsWith('.env'),
});

/** Agent row fields shared by every claude-code agent stub in this file. */
const CLAUDE_AGENT = { adapterName: CLAUDE_ADAPTER, cwd: TEST_CWD };

/**
 * Send a toolApprove request as the claude-code adapter.
 * @param toolName - Native Claude tool name
 * @param args - Tool call input
 * @param adapterName - Adapter name on the request
 * @returns The approval response
 */
function approve(toolName: string, args: Record<string, unknown> = {}, adapterName: string = CLAUDE_ADAPTER) {
  return MakaioBus.request(AgentSubjects.toolApprove, createToolApprovePayload({ adapterName, toolName, args }));
}

describe('ToolApprovalService - headless tool-list grant', () => {
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

  describe("allowlist ['read_file', 'edit_file']", () => {
    beforeEach(() => {
      registerAgentStub(cleanups, { ...CLAUDE_AGENT, allowedTools: ['read_file', 'edit_file'] });
    });

    it('allows Read and Edit without any approval handler', async () => {
      const read = await approve('Read', { file_path: `${TEST_CWD}/readme.txt` });
      const edit = await approve('Edit', { file_path: `${TEST_CWD}/src/a.ts`, old_string: 'a', new_string: 'b' });

      expect(read).toEqual({ action: 'allow' });
      expect(edit).toEqual({ action: 'allow' });
    });

    it('denies Bash as not on the allowlist', async () => {
      const result = await approve('Bash', { command: 'ls' });

      expect(result.action).toBe('deny');
      if (result.action === 'deny') {
        expect(result.message).toBe("Tool Bash is not on the step's allowlist");
        expect(result.shouldAbort).toBe(false);
      }
    });

    it('denies a .env read via .makaioignore even though read_file is listed', async () => {
      const result = await approve('Read', { file_path: `${TEST_CWD}/.env` });

      expect(result.action).toBe('deny');
      if (result.action === 'deny') {
        expect(result.message).toContain('.makaioignore');
        expect(result.shouldAbort).toBe(false);
      }
    });

    it('lets a session reject override win over the allowlist', async () => {
      registerSessionStorageHandler(cleanups, 'reject');

      const result = await approve('Read', { file_path: `${TEST_CWD}/readme.txt` });

      expect(result.action).toBe('deny');
      if (result.action === 'deny') {
        expect(result.message).toBe('Tool use rejected by session approval policy override');
      }
    });

    it('lets a session always-ask override win over the allowlist', async () => {
      registerSessionStorageHandler(cleanups, 'always-ask');

      const result = await approve('Read', { file_path: `${TEST_CWD}/readme.txt` });

      expect(result.action).toBe('deny');
      if (result.action === 'deny') {
        expect(result.message).toBe(NO_HANDLER);
      }
    });

    it('lets a harness per-tool reject win over the allowlist', async () => {
      cleanups.push(
        MakaioBus.on(
          HarnessSubjects.resolve,
          (ctx) => {
            ctx.setResult({
              id: 'reject-read-harness',
              name: 'reject-read',
              description: 'Harness rejecting Read',
              adapterName: CLAUDE_ADAPTER,
              approvalPolicy: 'always-ask',
              toolApprovalOverrides: { Read: 'reject' },
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

      const read = await approve('Read', { file_path: `${TEST_CWD}/readme.txt` });
      const edit = await approve('Edit', { file_path: `${TEST_CWD}/src/a.ts`, old_string: 'a', new_string: 'b' });

      expect(read.action).toBe('deny');
      if (read.action === 'deny') {
        expect(read.message).toBe('Tool use rejected by approval policy');
      }
      // Tools without the per-tool reject keep the headless grant.
      expect(edit).toEqual({ action: 'allow' });
    });
  });

  describe('command rules and MCP entries', () => {
    it("allows Bash 'git status' and denies 'git push' for shell_exec(git status)", async () => {
      registerAgentStub(cleanups, { ...CLAUDE_AGENT, allowedTools: ['shell_exec(git status)'] });

      const status = await approve('Bash', { command: 'git status' });
      const push = await approve('Bash', { command: 'git push' });

      expect(status).toEqual({ action: 'allow' });
      expect(push.action).toBe('deny');
      if (push.action === 'deny') {
        expect(push.message).toBe("Tool Bash is not on the step's allowlist");
      }
    });

    it('allows a listed MCP tool', async () => {
      registerAgentStub(cleanups, { ...CLAUDE_AGENT, allowedTools: ['mcp__s__t'] });

      const result = await approve('mcp__s__t', { q: 'x' });

      expect(result).toEqual({ action: 'allow' });
    });
  });

  describe('no grant applies', () => {
    it('falls through to the approval request when the agent has no lists', async () => {
      registerAgentStub(cleanups, CLAUDE_AGENT);

      const result = await approve('Read', { file_path: `${TEST_CWD}/readme.txt` });

      expect(result.action).toBe('deny');
      if (result.action === 'deny') {
        expect(result.message).toBe(NO_HANDLER);
      }
    });

    it('falls through for an adapter without a tool vocabulary (codex-app-server)', async () => {
      registerAgentStub(cleanups, { cwd: TEST_CWD, adapterName: 'codex-app-server', allowedTools: ['read_file'] });

      const result = await approve('Read', { file_path: `${TEST_CWD}/readme.txt` }, 'codex-app-server');

      expect(result.action).toBe('deny');
      if (result.action === 'deny') {
        expect(result.message).toBe(NO_HANDLER);
      }
    });

    it("denylist-only ['shell_exec'] denies Bash and lets Read fall through", async () => {
      registerAgentStub(cleanups, { ...CLAUDE_AGENT, disallowedTools: ['shell_exec'] });

      const bash = await approve('Bash', { command: 'ls' });
      const read = await approve('Read', { file_path: `${TEST_CWD}/readme.txt` });

      expect(bash.action).toBe('deny');
      if (bash.action === 'deny') {
        expect(bash.message).toBe("Tool Bash is denied by the step's denylist entry shell_exec");
      }
      expect(read.action).toBe('deny');
      if (read.action === 'deny') {
        expect(read.message).toBe(NO_HANDLER);
      }
    });
  });

  it('denies with the ToolNameError message for an invalid stored entry', async () => {
    registerAgentStub(cleanups, { ...CLAUDE_AGENT, allowedTools: ['Read'] });

    const result = await approve('Read', { file_path: `${TEST_CWD}/readme.txt` });

    expect(result.action).toBe('deny');
    if (result.action === 'deny') {
      expect(result.message).toContain('Invalid tool list entry "Read"');
      expect(result.shouldAbort).toBe(false);
    }
  });
});
