import { describe, expect, it } from 'bun:test';
import { providerIds } from '../provider.js';

describe('Claude Code tmux provider presets', () => {
  it('only declares Claude Code-authenticated Anthropic providers', () => {
    expect(providerIds).toEqual(['anthropic', 'anthropic-oauth']);
  });
});
