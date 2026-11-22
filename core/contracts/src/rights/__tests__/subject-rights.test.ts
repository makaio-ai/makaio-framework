import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  SUBJECT_SEND_RIGHT,
  SUBJECT_SUBSCRIBE_RIGHT,
  SubjectSendRightContextSchema,
  SubjectSubscribeRightContextSchema,
  type SubjectSubscribeRightContext,
} from '../index.js';
import { EntryIdSchema, SubjectNameSchema } from '../../journal/index.js';

describe('SubjectSubscribeRightContextSchema', () => {
  it('accepts a subject target, with and without payload and check', () => {
    expect(SubjectSubscribeRightContextSchema.safeParse({ subject: 'a.b' }).success).toBe(true);
    expect(
      SubjectSubscribeRightContextSchema.safeParse({ subject: 'a.b', payload: { x: 1 }, check: { y: 2 } }).success,
    ).toBe(true);
  });

  it('accepts a pattern target, with and without payload and check', () => {
    expect(SubjectSubscribeRightContextSchema.safeParse({ pattern: 'a.*' }).success).toBe(true);
    expect(
      SubjectSubscribeRightContextSchema.safeParse({ pattern: 'a.*', payload: { x: 1 }, check: { y: 2 } }).success,
    ).toBe(true);
  });

  it('rejects a context naming neither target', () => {
    expect(SubjectSubscribeRightContextSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a context naming both targets', () => {
    expect(SubjectSubscribeRightContextSchema.safeParse({ subject: 'a.b', pattern: 'a.*' }).success).toBe(false);
  });

  // Runtime only: without `exactOptionalPropertyTypes` the type `pattern?: never` admits an explicit `undefined`.
  it('rejects the other target when it is present but explicitly undefined', () => {
    expect(SubjectSubscribeRightContextSchema.safeParse({ subject: 'a.b', pattern: undefined }).success).toBe(false);
    expect(SubjectSubscribeRightContextSchema.safeParse({ pattern: 'a.*', subject: undefined }).success).toBe(false);
  });

  it('rejects an empty subject', () => {
    expect(SubjectSubscribeRightContextSchema.safeParse({ subject: '' }).success).toBe(false);
  });

  it('rejects an empty pattern', () => {
    expect(SubjectSubscribeRightContextSchema.safeParse({ pattern: '' }).success).toBe(false);
  });

  it('rejects an unknown extra key', () => {
    expect(SubjectSubscribeRightContextSchema.safeParse({ subject: 'a.b', extra: true }).success).toBe(false);
  });
});

describe('SubjectSendRightContextSchema', () => {
  it('accepts a subject, with and without payload and check', () => {
    expect(SubjectSendRightContextSchema.safeParse({ subject: 'a.b' }).success).toBe(true);
    expect(
      SubjectSendRightContextSchema.safeParse({ subject: 'a.b', payload: { x: 1 }, check: { y: 2 } }).success,
    ).toBe(true);
  });

  it('rejects a missing subject', () => {
    expect(SubjectSendRightContextSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an empty subject', () => {
    expect(SubjectSendRightContextSchema.safeParse({ subject: '' }).success).toBe(false);
  });

  it('rejects an unknown extra key', () => {
    expect(SubjectSendRightContextSchema.safeParse({ subject: 'a.b', extra: true }).success).toBe(false);
  });
});

describe('subject right names', () => {
  it('equal their documented names', () => {
    expect(SUBJECT_SEND_RIGHT).toBe('makaio.subject.send');
    expect(SUBJECT_SUBSCRIBE_RIGHT).toBe('makaio.subject.subscribe');
  });

  it('types the subscribe context as a union in which subject and pattern cannot both be strings', () => {
    expectTypeOf<{ subject: string; pattern: string }>().not.toMatchTypeOf<SubjectSubscribeRightContext>();
  });
});

describe('SubjectNameSchema and EntryIdSchema', () => {
  it('reject an empty string', () => {
    expect(SubjectNameSchema.safeParse('').success).toBe(false);
    expect(EntryIdSchema.safeParse('').success).toBe(false);
  });

  it('accept a non-empty string', () => {
    expect(SubjectNameSchema.safeParse('a.b').success).toBe(true);
    expect(EntryIdSchema.safeParse('entry-1').success).toBe(true);
  });
});
