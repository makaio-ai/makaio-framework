import { describe, expect, it } from 'vitest';
import { WorkflowSubjects } from '../namespace.js';

describe('WorkflowNamespace', () => {
  it('exposes dotted lifecycle subjects as nested accessors', () => {
    expect(WorkflowSubjects.start.subject).toBe('start');
    expect(WorkflowSubjects.gate.respond.subject).toBe('gate.respond');
    expect(WorkflowSubjects.gate.requested.subject).toBe('gate.requested');
    expect(WorkflowSubjects.execution.started.subject).toBe('execution.started');
    expect(WorkflowSubjects.step.beforeStart.subject).toBe('step.beforeStart');
    expect(WorkflowSubjects.step.completed.subject).toBe('step.completed');
  });
});
