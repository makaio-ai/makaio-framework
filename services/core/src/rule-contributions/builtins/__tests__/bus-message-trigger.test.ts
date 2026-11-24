import { describe, expect, it } from 'vitest';
import { BUS_MESSAGE_TRIGGER_KIND, BusMessageTriggerParamsSchema, busMessageTrigger } from '../bus-message-trigger.js';

describe('busMessageTrigger (makaio.bus-message)', () => {
  it('carries its canonical kind', () => {
    expect(busMessageTrigger.kind).toBe(BUS_MESSAGE_TRIGGER_KIND);
    expect(busMessageTrigger.kind).toBe('makaio.bus-message');
  });

  it('accepts a subject pattern and rejects anything else', () => {
    expect(() => BusMessageTriggerParamsSchema.parse({ subject: 'git.worktree' })).not.toThrow();
    expect(() => BusMessageTriggerParamsSchema.parse({ subject: 'github.*' })).not.toThrow();
    expect(() => BusMessageTriggerParamsSchema.parse({ subject: 'not-addressable' })).toThrow();
    expect(() => BusMessageTriggerParamsSchema.parse({})).toThrow();
  });

  it('subjects(params) yields the one pattern from the fixed parameters', () => {
    expect(busMessageTrigger.subjects({ subject: 'git.worktree' })).toEqual(['git.worktree']);
    expect(busMessageTrigger.subjects({ subject: 'github.*' })).toEqual(['github.*']);
  });

  it('facts() describes the subject and payload shape, independent of params', () => {
    const schema = busMessageTrigger.facts(undefined, undefined);
    expect(schema).toMatchObject({
      type: 'object',
      properties: { subject: { type: 'string' } },
    });
  });

  it('toFacts(message) yields the subject and payload of a recorded row verbatim', () => {
    const facts = busMessageTrigger.toFacts({ subject: 'git.worktree', payload: { branch: 'main' } });
    expect(facts).toEqual({ subject: 'git.worktree', payload: { branch: 'main' } });
  });

  it('toFacts(message) carries a non-object payload through unchanged', () => {
    expect(busMessageTrigger.toFacts({ subject: 'git.worktree', payload: 'plain-string' })).toEqual({
      subject: 'git.worktree',
      payload: 'plain-string',
    });
  });
});
