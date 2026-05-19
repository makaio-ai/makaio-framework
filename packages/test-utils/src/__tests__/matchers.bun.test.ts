import { describe, expect, it, mock } from 'bun:test';

describe('toHaveBeenCalledOnce (custom matcher)', () => {
  it('passes when mock was called exactly once', () => {
    const fn = mock();
    fn();
    expect(fn).toHaveBeenCalledOnce();
  });

  it('fails when mock was not called', () => {
    const fn = mock();
    expect(() => expect(fn).toHaveBeenCalledOnce()).toThrow();
  });

  it('fails when mock was called more than once', () => {
    const fn = mock();
    fn();
    fn();
    expect(() => expect(fn).toHaveBeenCalledOnce()).toThrow();
  });
});
