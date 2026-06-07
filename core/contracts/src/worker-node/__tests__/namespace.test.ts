import { describe, expect, it } from 'vitest';
import { WorkerNodeSchemas, WorkerNodeSubjects } from '../index.js';

describe('worker-node namespace', () => {
  it('registers lifecycle subjects under worker-node', () => {
    expect(WorkerNodeSubjects.lifecycle.ready.$meta.namespace).toBe('worker-node');
    expect(WorkerNodeSubjects.lifecycle.ready.subject).toBe('lifecycle.ready');
  });

  it('registers dispatch under worker-node', () => {
    expect(WorkerNodeSubjects.dispatch.$meta.namespace).toBe('worker-node');
    expect(WorkerNodeSubjects.dispatch.subject).toBe('dispatch');
  });

  it('keeps pool identity out of framework lifecycle payloads', () => {
    const parsed = WorkerNodeSchemas['lifecycle.ready'].parse({
      nodeId: 'node-1',
      executionId: 'wfx-1',
      environment: 'piscina',
      poolId: 'pool-1',
      adapters: ['claude-code'],
      metadata: { source: 'test' },
    });

    expect(parsed).toStrictEqual({
      nodeId: 'node-1',
      executionId: 'wfx-1',
      environment: 'piscina',
      adapters: ['claude-code'],
      metadata: { source: 'test' },
    });
    expect('poolId' in parsed).toBe(false);
  });

  it('registers control ready under worker-node', () => {
    expect(WorkerNodeSubjects.control.ready.$meta.namespace).toBe('worker-node');
    expect(WorkerNodeSubjects.control.ready.subject).toBe('control.ready');
  });

  it('parses control ready payloads', () => {
    const parsed = WorkerNodeSchemas['control.ready'].parse({
      nodeId: 'node-1',
      executionId: 'wfx-1',
      adapters: ['claude-code'],
    });

    expect(parsed).toStrictEqual({
      nodeId: 'node-1',
      executionId: 'wfx-1',
      adapters: ['claude-code'],
    });
  });

  describe('lifecycle.paused', () => {
    it('defines lifecycle.paused with required gate and frame identity', () => {
      const parsed = WorkerNodeSchemas['lifecycle.paused'].parse({
        nodeId: 'node-1',
        executionId: 'wfx-1',
        environment: 'piscina',
        pausedAtGateId: 'approve',
        pausedAtFrameId: 'frame-approve-1',
      });

      expect(parsed).toMatchObject({
        nodeId: 'node-1',
        executionId: 'wfx-1',
        pausedAtGateId: 'approve',
        pausedAtFrameId: 'frame-approve-1',
      });
    });

    it('rejects lifecycle.paused without pausedAtGateId', () => {
      expect(() =>
        WorkerNodeSchemas['lifecycle.paused'].parse({
          nodeId: 'node-1',
          executionId: 'wfx-1',
          environment: 'piscina',
          pausedAtFrameId: 'frame-approve-1',
        }),
      ).toThrow();
    });

    it('rejects lifecycle.paused without pausedAtFrameId', () => {
      expect(() =>
        WorkerNodeSchemas['lifecycle.paused'].parse({
          nodeId: 'node-1',
          executionId: 'wfx-1',
          environment: 'piscina',
          pausedAtGateId: 'approve',
        }),
      ).toThrow();
    });
  });
});
