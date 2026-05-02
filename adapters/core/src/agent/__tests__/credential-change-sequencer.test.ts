import { describe, expect, it } from 'vitest';
import { CredentialChangeSequencer } from '../credential-change-sequencer.js';

describe('CredentialChangeSequencer', () => {
  it('serializes actions through runExclusive in call order', async () => {
    const sequencer = new CredentialChangeSequencer();
    const events: string[] = [];

    const first = sequencer.runExclusive(async () => {
      events.push('first:start');
      await Promise.resolve();
      events.push('first:end');
    });
    const second = sequencer.runExclusive(async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('continues queued actions when a prior runExclusive action throws', async () => {
    const sequencer = new CredentialChangeSequencer();
    const events: string[] = [];

    const first = sequencer.runExclusive(async () => {
      events.push('first:start');
      throw new Error('boom');
    });
    const second = sequencer.runExclusive(async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await expect(first).rejects.toThrow('boom');
    await second;

    expect(events).toEqual(['first:start', 'second:start', 'second:end']);
  });

  it('releases a queued sequence after a failure path', () => {
    const sequencer = new CredentialChangeSequencer();

    expect(sequencer.queue('provider-a', 1)).toBe(true);
    sequencer.release('provider-a', 1);

    expect(sequencer.isLatest('provider-a', 1)).toBe(false);
  });

  it('rejects invalid sequence numbers at ingress', () => {
    const sequencer = new CredentialChangeSequencer();

    expect(sequencer.queue('provider-a', Number.NaN)).toBe(false);
    expect(sequencer.queue('provider-a', -1)).toBe(false);
    expect(sequencer.queue('provider-a', 1.5)).toBe(false);
  });

  it('accepts sequence zero when no prior sequence exists', () => {
    const sequencer = new CredentialChangeSequencer();

    expect(sequencer.queue('provider-a', 0)).toBe(true);
    expect(sequencer.isLatest('provider-a', 0)).toBe(true);
  });

  it('rejects sequence zero after it has been applied', () => {
    const sequencer = new CredentialChangeSequencer();

    expect(sequencer.queue('provider-a', 0)).toBe(true);
    sequencer.markApplied('provider-a', 0);

    expect(sequencer.queue('provider-a', 0)).toBe(false);
  });

  it('keeps applied sequences monotonic and clears the matching queued sequence', () => {
    const sequencer = new CredentialChangeSequencer();

    expect(sequencer.queue('provider-a', 2)).toBe(true);
    sequencer.markApplied('provider-a', 2);
    sequencer.markApplied('provider-a', 1);

    expect(sequencer.isLatest('provider-a', 2)).toBe(false);
    expect(sequencer.queue('provider-a', 1)).toBe(false);
    expect(sequencer.queue('provider-a', 3)).toBe(true);
  });

  it('clears tracked state for a provider config lifecycle', () => {
    const sequencer = new CredentialChangeSequencer();

    expect(sequencer.queue('provider-a', 2)).toBe(true);
    sequencer.markApplied('provider-a', 2);
    sequencer.clear('provider-a');

    expect(sequencer.queue('provider-a', 1)).toBe(true);
  });
});
