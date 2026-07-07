/**
 * Tests for {@link evaluateNativeLocality}.
 *
 * Each case exercises a single disqualifying condition or the happy path to
 * ensure the verdict ordering is correct and every reason code is reachable.
 */
import { describe, expect, it } from 'vitest';
import { evaluateNativeLocality } from '../native-locality.js';

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

/** Stable adapter name shared by the base session and all test inputs. */
const ADAPTER_NAME = 'test-adapter';

/** Minimal valid session that passes all checks (local, native, no transforms). */
const BASE_SESSION = {
  sessionId: 's',
  status: 'active' as const,
  createdAt: 1,
  lastActivityAt: 1,
  agents: [],
  adapterSessionId: 'native',
  adapterName: ADAPTER_NAME,
  machineId: 'local',
};

/** Shared base input that passes all locality checks. */
const BASE_INPUT = {
  intent: 'resume' as const,
  session: BASE_SESSION,
  localMachineId: 'local',
  adapterSupportsNative: true,
  targetAdapterName: ADAPTER_NAME,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('evaluateNativeLocality', () => {
  it('returns native when session is local, adapter supports, and no transforms', () => {
    expect(evaluateNativeLocality(BASE_INPUT)).toEqual({ kind: 'native' });
  });

  it('degrades on adapter-unsupported', () => {
    expect(
      evaluateNativeLocality({
        ...BASE_INPUT,
        adapterSupportsNative: false,
      }),
    ).toEqual({ kind: 'degrade', reason: 'adapter-unsupported' });
  });

  it('degrades on adapter-mismatch when target adapter differs from session adapter', () => {
    expect(
      evaluateNativeLocality({
        ...BASE_INPUT,
        targetAdapterName: 'different-adapter',
      }),
    ).toEqual({ kind: 'degrade', reason: 'adapter-mismatch' });
  });

  it('allows native when session has no stored adapterName (legacy)', () => {
    expect(
      evaluateNativeLocality({
        ...BASE_INPUT,
        session: { ...BASE_SESSION, adapterName: undefined },
      }),
    ).toEqual({ kind: 'native' });
  });

  it('degrades on no-adapter-session', () => {
    expect(
      evaluateNativeLocality({
        ...BASE_INPUT,
        session: { ...BASE_SESSION, adapterSessionId: undefined },
      }),
    ).toEqual({ kind: 'degrade', reason: 'no-adapter-session' });
  });

  it('degrades on missing-machine-id when session has no machineId', () => {
    expect(
      evaluateNativeLocality({
        ...BASE_INPUT,
        session: { ...BASE_SESSION, machineId: undefined },
      }),
    ).toEqual({ kind: 'degrade', reason: 'missing-machine-id' });
  });

  it('degrades on missing-machine-id when session machineId is null', () => {
    expect(
      evaluateNativeLocality({
        ...BASE_INPUT,
        session: { ...BASE_SESSION, machineId: null },
      }),
    ).toEqual({ kind: 'degrade', reason: 'missing-machine-id' });
  });

  it('degrades on missing-machine-id when localMachineId is undefined', () => {
    expect(
      evaluateNativeLocality({
        ...BASE_INPUT,
        localMachineId: undefined,
      }),
    ).toEqual({ kind: 'degrade', reason: 'missing-machine-id' });
  });

  it('returns foreign when machine ids differ', () => {
    expect(
      evaluateNativeLocality({
        ...BASE_INPUT,
        session: { ...BASE_SESSION, machineId: 'remote' },
      }),
    ).toEqual({ kind: 'foreign', machineId: 'remote' });
  });

  it('degrades on hybrid-imported-orchestrated', () => {
    expect(
      evaluateNativeLocality({
        ...BASE_INPUT,
        session: { ...BASE_SESSION, isImported: true, isOrchestrated: true },
      }),
    ).toEqual({ kind: 'degrade', reason: 'hybrid-imported-orchestrated' });
  });

  it('allows imported-only (not orchestrated) to pass through', () => {
    expect(
      evaluateNativeLocality({
        ...BASE_INPUT,
        session: { ...BASE_SESSION, isImported: true, isOrchestrated: false },
      }),
    ).toEqual({ kind: 'native' });
  });

  it('degrades on compression-present', () => {
    expect(
      evaluateNativeLocality({
        ...BASE_INPUT,
        sessionContext: { hasCompression: true },
      }),
    ).toEqual({ kind: 'degrade', reason: 'compression-present' });
  });

  it('degrades on transforms-present for fork with forkTransforms on session', () => {
    expect(
      evaluateNativeLocality({
        ...BASE_INPUT,
        intent: 'fork',
        session: { ...BASE_SESSION, forkTransforms: { removedMessageIds: [] } },
      }),
    ).toEqual({ kind: 'degrade', reason: 'transforms-present' });
  });

  it('does not degrade when forkTransforms is explicitly undefined', () => {
    expect(
      evaluateNativeLocality({
        ...BASE_INPUT,
        intent: 'fork',
        session: { ...BASE_SESSION, forkTransforms: undefined },
      }),
    ).toEqual({ kind: 'native' });
  });

  it('degrades on transforms-present when sessionContext.hasNewTransforms is set', () => {
    expect(
      evaluateNativeLocality({
        ...BASE_INPUT,
        sessionContext: { hasNewTransforms: true },
      }),
    ).toEqual({ kind: 'degrade', reason: 'transforms-present' });
  });

  it('degrades on connector-swap', () => {
    expect(
      evaluateNativeLocality({
        ...BASE_INPUT,
        sessionContext: { hasConnectorSwap: true },
      }),
    ).toEqual({ kind: 'degrade', reason: 'connector-swap' });
  });

  it('degrades on cwd-mismatch when cwds differ', () => {
    expect(
      evaluateNativeLocality({
        ...BASE_INPUT,
        currentCwd: '/old/path',
        targetCwd: '/new/path',
      }),
    ).toEqual({ kind: 'degrade', reason: 'cwd-mismatch' });
  });

  it('does not degrade on cwd when only one of currentCwd/targetCwd is supplied', () => {
    expect(
      evaluateNativeLocality({
        ...BASE_INPUT,
        currentCwd: '/path',
      }),
    ).toEqual({ kind: 'native' });
  });

  it('degrades on mid-history-unsupported for fork with forkPointMessageId but no support', () => {
    expect(
      evaluateNativeLocality({
        ...BASE_INPUT,
        intent: 'fork',
        session: { ...BASE_SESSION, forkPointMessageId: 'message-1' },
        midHistoryForkSupported: false,
      }),
    ).toEqual({ kind: 'degrade', reason: 'mid-history-unsupported' });
  });

  it('returns native for fork with forkPointMessageId when mid-history is supported', () => {
    expect(
      evaluateNativeLocality({
        ...BASE_INPUT,
        intent: 'fork',
        session: { ...BASE_SESSION, forkPointMessageId: 'message-1' },
        midHistoryForkSupported: true,
      }),
    ).toEqual({ kind: 'native' });
  });
});
