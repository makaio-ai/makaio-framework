import { describe, expect, it } from 'vitest';
import { createTestCall } from '@makaio/test-utils';
import { isCallerAuthorizedToDelegate, type SpawnDelegationAllowSet } from '../spawn-delegation.js';

describe('isCallerAuthorizedToDelegate', () => {
  it('returns false when the allow-set is empty for non-job-run callers', () => {
    const emptySet: SpawnDelegationAllowSet = new Set();
    expect(
      isCallerAuthorizedToDelegate(createTestCall({ caller: { kind: 'makaio.machine', id: 'node-1' } }), emptySet),
    ).toBe(false);
  });

  it('returns true for job-run callers without an explicit grant', () => {
    const emptySet: SpawnDelegationAllowSet = new Set();
    expect(
      isCallerAuthorizedToDelegate(createTestCall({ caller: { kind: 'makaio.job-run', id: 'exec-1' } }), emptySet),
    ).toBe(true);
  });

  it('returns false when the caller identity is not in a non-empty allow-set', () => {
    const allowSet: SpawnDelegationAllowSet = new Set(['makaio.machine:node-1']);
    const call = createTestCall({ caller: { kind: 'test.browser', id: 'test.browser-1' } });
    expect(isCallerAuthorizedToDelegate(call, allowSet)).toBe(false);
  });

  it('returns false for a remote caller with an empty allow-set', () => {
    const emptySet: SpawnDelegationAllowSet = new Set();
    const call = createTestCall({ caller: { kind: 'test.browser', id: 'test.browser-1' } });
    expect(isCallerAuthorizedToDelegate(call, emptySet)).toBe(false);
  });

  it('returns false for a workflow-like caller with an execution claim', () => {
    const allowSet: SpawnDelegationAllowSet = new Set(['makaio.job-run:exec-1']);
    const call = createTestCall({ caller: { kind: 'test.workflow', id: 'exec-1', claims: { executionId: 'exec-1' } } });
    expect(isCallerAuthorizedToDelegate(call, allowSet)).toBe(false);
  });

  it('returns true for a makaio.job-run caller', () => {
    const allowSet: SpawnDelegationAllowSet = new Set(['makaio.machine:node-1']);
    const call = createTestCall({ caller: { kind: 'makaio.job-run', id: 'exec-1' } });
    expect(isCallerAuthorizedToDelegate(call, allowSet)).toBe(true);
  });

  it('returns false when caller kind does not match any entry', () => {
    const allowSet: SpawnDelegationAllowSet = new Set(['makaio.job-run:exec-1']);
    expect(
      isCallerAuthorizedToDelegate(createTestCall({ caller: { kind: 'test.browser', id: 'exec-1' } }), allowSet),
    ).toBe(false);
  });

  it('returns false when non-job-run caller id does not match any entry', () => {
    const allowSet: SpawnDelegationAllowSet = new Set(['makaio.machine:node-1']);
    expect(
      isCallerAuthorizedToDelegate(createTestCall({ caller: { kind: 'makaio.machine', id: 'node-2' } }), allowSet),
    ).toBe(false);
  });

  it('returns true when non-workflow caller kind and id both match an entry', () => {
    const allowSet: SpawnDelegationAllowSet = new Set(['makaio.machine:node-1']);
    expect(
      isCallerAuthorizedToDelegate(createTestCall({ caller: { kind: 'makaio.machine', id: 'node-1' } }), allowSet),
    ).toBe(true);
  });

  it('returns true for the correct entry among multiple entries', () => {
    const allowSet: SpawnDelegationAllowSet = new Set([
      'makaio.machine:node-1',
      'makaio.machine:node-2',
      'makaio.machine:node-3',
    ]);
    expect(
      isCallerAuthorizedToDelegate(createTestCall({ caller: { kind: 'makaio.machine', id: 'node-2' } }), allowSet),
    ).toBe(true);
  });
});
