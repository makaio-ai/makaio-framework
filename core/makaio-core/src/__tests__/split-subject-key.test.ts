import { describe, expect, it } from 'vitest';
import { splitSubjectKey } from '../subject-helpers/split-subject-key.js';

describe('splitSubjectKey', () => {
  it('splits at the first dot', () => {
    expect(splitSubjectKey('git.worktree')).toEqual({ namespace: 'git', subject: 'worktree' });
    expect(splitSubjectKey('workflow.step.completed')).toEqual({ namespace: 'workflow', subject: 'step.completed' });
  });

  it('treats a colon as a namespace hierarchy boundary, not a separator', () => {
    expect(splitSubjectKey('storage:workflow.list')).toEqual({ namespace: 'storage:workflow', subject: 'list' });
  });

  it('accepts a namespace-level wildcard as the subject segment', () => {
    expect(splitSubjectKey('github.*')).toEqual({ namespace: 'github', subject: '*' });
  });

  it('rejects keys that do not name both segments', () => {
    expect(splitSubjectKey('nodot')).toBeUndefined();
    expect(splitSubjectKey('.subject')).toBeUndefined();
    expect(splitSubjectKey('namespace.')).toBeUndefined();
    expect(splitSubjectKey('.')).toBeUndefined();
    expect(splitSubjectKey('')).toBeUndefined();
  });
});
