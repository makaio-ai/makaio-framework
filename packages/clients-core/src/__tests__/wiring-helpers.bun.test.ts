import { describe, expect, it } from 'bun:test';
import { buildClientCommand, buildHookCommand } from '../wiring-helpers.js';

describe('buildClientCommand', () => {
  it('quotes the executable token when rendering non-hook client commands', () => {
    expect(buildClientCommand("/Applications/Makaio CLI/bin/makai'o", ['claude', 'statusline'])).toBe(
      "'/Applications/Makaio CLI/bin/makai'\\''o' claude statusline",
    );
  });
});

describe('buildHookCommand', () => {
  it('leaves simple command tokens unchanged', () => {
    expect(buildHookCommand('makaio', 'hook received codex', 'SessionStart')).toBe(
      'makaio hook received codex SessionStart',
    );
  });

  it('quotes the executable token when the makaio command is a path with shell-sensitive characters', () => {
    expect(buildHookCommand("/Applications/Makaio CLI/bin/makai'o", 'hook received codex', 'SessionStart')).toBe(
      "'/Applications/Makaio CLI/bin/makai'\\''o' hook received codex SessionStart",
    );
  });
});
