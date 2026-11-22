import { describe, expect, it } from 'vitest';
import { isSubjectName, isSubjectPattern } from '../subject-helpers/subject-grammar.js';

describe('isSubjectName', () => {
  it.each([
    ['git.worktree', true],
    ['storage:workflow.list', true],
    ['github.pull-request.opened', true],
    ['nodot', false],
    ['.x', false],
    ['x.', false],
    ['', false],
    ['github.*', false],
    ['foo*bar', false],
    ['foo**', false],
  ])('isSubjectName(%j) === %p', (value, expected) => {
    expect(isSubjectName(value)).toBe(expected);
  });
});

describe('isSubjectPattern', () => {
  it.each([
    ['*', true],
    ['git.worktree', true],
    ['storage:workflow.list', true],
    ['github.pull-request.*', true],
    ['a:b:*', true],
    ['a:b.*', true],
    ['nodot', false],
    ['.x', false],
    ['x.', false],
    ['foo*bar', false],
    ['foo**', false],
    ['a.*.b', false],
    [':*', false],
    ['.*', false],
    ['a.b:*', false],
  ])('isSubjectPattern(%j) === %p', (value, expected) => {
    expect(isSubjectPattern(value)).toBe(expected);
  });
});
