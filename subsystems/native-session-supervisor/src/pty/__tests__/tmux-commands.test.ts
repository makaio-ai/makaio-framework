/**
 * The tmux command layer: bounded blocking and outcome classification.
 *
 * Every assertion here runs a real child process. The bound is asserted on
 * *elapsed time*, because that is the only thing that catches a re-introduced
 * unbounded wait — an error message can be produced by a call that blocked for
 * thirty seconds just as easily as by one that blocked for a tenth of a second.
 */

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runTmuxCommand, tmuxExec } from '../tmux-commands.js';

/**
 * Install a stub `tmux` that never returns, and put it first on `PATH`.
 * @returns Directory holding the stub.
 */
function installHangingTmux(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmux-hang-'));
  const stub = join(dir, 'tmux');
  writeFileSync(stub, '#!/bin/sh\nwhile true; do sleep 1; done\n', 'utf8');
  chmodSync(stub, 0o755);
  return dir;
}

describe('tmux command layer', () => {
  let originalPath: string | undefined;

  beforeEach(() => {
    originalPath = process.env['PATH'];
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = originalPath;
  });

  // Case 227 arm (c). Bounded blocking, and nothing more: the call is
  // synchronous, so the timeout bounds how long the event loop is held. It does
  // not make the call interruptible, and this asserts only what is delivered.
  it('tmuxExec fails at its timeout when tmux never returns', () => {
    process.env['PATH'] = `${installHangingTmux()}:${originalPath ?? ''}`;

    const budgetMs = 300;
    const startedAt = Date.now();
    expect(() => tmuxExec('any-server', ['list-sessions'], budgetMs)).toThrow();
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(budgetMs * 0.5);
    expect(elapsedMs).toBeLessThan(budgetMs * 4);
  });

  it('classifies a command that never returns as unanswerable, not as absence', () => {
    process.env['PATH'] = `${installHangingTmux()}:${originalPath ?? ''}`;

    const outcome = runTmuxCommand('any-server', ['has-session', '-t', 'whatever'], 300);

    expect(outcome.kind).toBe('unanswerable');
  });

  it('classifies a missing tmux executable as unanswerable', () => {
    process.env['PATH'] = '/nonexistent-path-for-tmux-command-test';

    const outcome = runTmuxCommand('any-server', ['has-session', '-t', 'whatever'], 1_000);

    expect(outcome.kind).toBe('unanswerable');
  });

  it('classifies an absent socket as unanswerable rather than as proven absence', () => {
    // A missing server does not prove a pane's process died: the tmux client,
    // not a server, produced this answer. Treating it as absence is exactly the
    // synthetic exit this layer exists to remove.
    const outcome = runTmuxCommand(`definitely-absent-${Date.now().toString()}`, ['has-session', '-t', 'x'], 2_000);

    expect(outcome.kind).toBe('unanswerable');
  });
});
