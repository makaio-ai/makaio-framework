import { describe, expect, it } from 'vitest';
import {
  NativeSessionSupervisorSubjects,
  NativeSupervisorLaunchSchema,
  NativeSupervisorAttachSchema,
  NativeSupervisorStopSchema,
  NativeSupervisorStatusSchema,
  SupervisorSessionStatusSchema,
} from '@makaio/contracts/native-session-supervisor';

describe('SupervisorSessionStatusSchema', () => {
  it("accepts 'unknown' status — used by startup reconciliation for stale rows", () => {
    // 'unknown' is assigned to persisted 'running' runtimes during supervisor
    // restart when the PTY handles are no longer valid in the new process.
    // This status must round-trip through the schema without rejection.
    const result = SupervisorSessionStatusSchema.safeParse('unknown');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe('unknown');
    }
  });

  it("accepts all valid lifecycle statuses: 'running', 'stopped', 'exited', 'unknown'", () => {
    const valid = ['running', 'stopped', 'exited', 'unknown'] as const;
    for (const status of valid) {
      expect(SupervisorSessionStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it('rejects statuses outside the defined enum', () => {
    expect(SupervisorSessionStatusSchema.safeParse('crashed').success).toBe(false);
    expect(SupervisorSessionStatusSchema.safeParse('pending').success).toBe(false);
    expect(SupervisorSessionStatusSchema.safeParse('').success).toBe(false);
  });

  it("validates a runtime snapshot with status 'unknown'", () => {
    // Verifies the full snapshot schema accepts 'unknown' since it embeds
    // SupervisorSessionStatusSchema for its status field.
    const result = NativeSupervisorStatusSchema.response.safeParse({
      runtimes: [
        {
          supervisorSessionId: 'sup-restarted-1',
          clientId: 'claude-code',
          pid: null,
          status: 'unknown',
          cwd: '/tmp',
          startedAt: 1_700_000_000_000,
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtimes[0]?.status).toBe('unknown');
    }
  });
});

describe('NativeSessionSupervisorSubjects', () => {
  it('exposes launch, attach, stop, and status subjects under the native-session-supervisor namespace', () => {
    expect(NativeSessionSupervisorSubjects.launch.subject).toBe('launch');
    expect(NativeSessionSupervisorSubjects.attach.subject).toBe('attach');
    expect(NativeSessionSupervisorSubjects.stop.subject).toBe('stop');
    expect(NativeSessionSupervisorSubjects.status.subject).toBe('status');

    expect(NativeSessionSupervisorSubjects.launch.$meta.namespace).toBe('native-session-supervisor');
    expect(NativeSessionSupervisorSubjects.attach.$meta.namespace).toBe('native-session-supervisor');
    expect(NativeSessionSupervisorSubjects.stop.$meta.namespace).toBe('native-session-supervisor');
    expect(NativeSessionSupervisorSubjects.status.$meta.namespace).toBe('native-session-supervisor');
  });
});

describe('NativeSupervisorLaunchSchema', () => {
  it('accepts a valid launch request', () => {
    const result = NativeSupervisorLaunchSchema.request.safeParse({
      clientId: 'claude-code',
      cwd: '/home/user/project',
      command: 'claude',
      args: ['--dangerously-skip-permissions'],
      env: { TERM: 'xterm-256color' },
      sessionId: 'session-abc',
      adapterSessionId: 'adapter-session-xyz',
      metadata: { source: 'test' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a minimal launch request (only required fields)', () => {
    const result = NativeSupervisorLaunchSchema.request.safeParse({
      clientId: 'claude-code',
      cwd: '/tmp',
      command: 'claude',
      args: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a launch request missing required fields', () => {
    expect(
      NativeSupervisorLaunchSchema.request.safeParse({
        cwd: '/tmp',
        command: 'claude',
        args: [],
      }).success,
    ).toBe(false);
  });

  it('validates a valid launch response', () => {
    const result = NativeSupervisorLaunchSchema.response.safeParse({
      supervisorSessionId: 'sup-session-1',
      pid: 12345,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.supervisorSessionId).toBe('sup-session-1');
      expect(result.data.pid).toBe(12345);
    }
  });

  it('rejects a launch response with a non-positive pid', () => {
    expect(
      NativeSupervisorLaunchSchema.response.safeParse({
        supervisorSessionId: 'sup-session-1',
        pid: 0,
      }).success,
    ).toBe(false);
  });
});

describe('NativeSupervisorAttachSchema', () => {
  it('accepts an attach request by supervisorSessionId', () => {
    const result = NativeSupervisorAttachSchema.request.safeParse({
      supervisorSessionId: 'sup-session-1',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an attach request by sessionId', () => {
    const result = NativeSupervisorAttachSchema.request.safeParse({
      sessionId: 'session-abc',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an attach request by adapterSessionId', () => {
    const result = NativeSupervisorAttachSchema.request.safeParse({
      adapterSessionId: 'adapter-session-xyz',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an attach request with none of the required locator fields', () => {
    expect(
      NativeSupervisorAttachSchema.request.safeParse({
        unrelated: 'value',
      }).success,
    ).toBe(false);
  });

  it('rejects an attach request with multiple locator fields (exactly-one semantics)', () => {
    expect(
      NativeSupervisorAttachSchema.request.safeParse({
        supervisorSessionId: 'sup-session-1',
        sessionId: 'session-abc',
      }).success,
    ).toBe(false);
  });

  it('validates a successful attach response with terminal attachment info', () => {
    const result = NativeSupervisorAttachSchema.response.safeParse({
      success: true,
      supervisorSessionId: 'sup-session-1',
      pid: 12345,
      terminalAttachment: { canAttach: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.terminalAttachment?.canAttach).toBe(true);
    }
  });

  it('validates a failed attach response', () => {
    const result = NativeSupervisorAttachSchema.response.safeParse({ success: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.success).toBe(false);
    }
  });
});

describe('NativeSupervisorStopSchema', () => {
  it('accepts a valid stop request', () => {
    const result = NativeSupervisorStopSchema.request.safeParse({
      supervisorSessionId: 'sup-session-1',
      signal: 'SIGTERM',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a stop request without an explicit signal', () => {
    const result = NativeSupervisorStopSchema.request.safeParse({
      supervisorSessionId: 'sup-session-1',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.signal).toBeUndefined();
    }
  });

  it('rejects a stop request missing supervisorSessionId', () => {
    expect(NativeSupervisorStopSchema.request.safeParse({ signal: 'SIGKILL' }).success).toBe(false);
  });

  it('validates a stop response', () => {
    expect(NativeSupervisorStopSchema.response.safeParse({ success: true }).success).toBe(true);
    expect(NativeSupervisorStopSchema.response.safeParse({ success: false }).success).toBe(true);
  });
});

describe('NativeSupervisorStatusSchema', () => {
  it('accepts an empty status request (returns all runtimes)', () => {
    const result = NativeSupervisorStatusSchema.request.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts a status request filtered by supervisorSessionId', () => {
    const result = NativeSupervisorStatusSchema.request.safeParse({
      supervisorSessionId: 'sup-session-1',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a status request filtered by sessionId', () => {
    const result = NativeSupervisorStatusSchema.request.safeParse({
      sessionId: 'session-abc',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a status request filtered by adapterSessionId', () => {
    const result = NativeSupervisorStatusSchema.request.safeParse({
      adapterSessionId: 'adapter-session-xyz',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a status request with multiple locator fields (exactly-one-or-none semantics)', () => {
    expect(
      NativeSupervisorStatusSchema.request.safeParse({
        supervisorSessionId: 'sup-session-1',
        sessionId: 'session-abc',
      }).success,
    ).toBe(false);
  });

  it('validates a status response with runtime snapshots', () => {
    const result = NativeSupervisorStatusSchema.response.safeParse({
      runtimes: [
        {
          supervisorSessionId: 'sup-session-1',
          clientId: 'claude-code',
          pid: 12345,
          status: 'running',
          cwd: '/home/user/project',
          sessionId: 'session-abc',
          startedAt: 1_713_795_200_000,
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtimes).toHaveLength(1);
      expect(result.data.runtimes[0]?.status).toBe('running');
    }
  });

  it('validates a status response with a null pid (exited process)', () => {
    const result = NativeSupervisorStatusSchema.response.safeParse({
      runtimes: [
        {
          supervisorSessionId: 'sup-session-2',
          clientId: 'claude-code',
          pid: null,
          status: 'exited',
          cwd: '/tmp',
          startedAt: 1_713_795_200_000,
          stoppedAt: 1_713_795_300_000,
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtimes[0]?.pid).toBeNull();
      expect(result.data.runtimes[0]?.status).toBe('exited');
    }
  });

  it('rejects a runtime snapshot with an invalid status', () => {
    const result = NativeSupervisorStatusSchema.response.safeParse({
      runtimes: [
        {
          supervisorSessionId: 'sup-session-3',
          clientId: 'claude-code',
          pid: 999,
          status: 'crashed',
          cwd: '/tmp',
          startedAt: 1_713_795_200_000,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('validates an empty runtimes array', () => {
    const result = NativeSupervisorStatusSchema.response.safeParse({ runtimes: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtimes).toHaveLength(0);
    }
  });
});
