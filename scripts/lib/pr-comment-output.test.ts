import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderReviewEntries, renderWorkflowReminder } from './pr-comment-output.js';

describe('renderReviewEntries', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('strips terminal control sequences from untrusted comment text', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    renderReviewEntries(
      [
        {
          state: 'COMMENTED',
          author: 'reviewer',
          body: 'safe\u001B[31mred\u001B[0m\u0007',
        },
      ],
      [
        {
          path: 'src/\u001B[31mfile.ts',
          line: 4,
          startLine: null,
          author: 'bot\u0007',
          body: 'body\u001B[2J',
          inReplyToId: null,
        },
      ],
    );

    const output = info.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).not.toContain('\u001B');
    expect(output).not.toContain('\u0007');
  });
});

describe('renderWorkflowReminder', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the caller-provided post-push command instead of a hardcoded workspace command', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    renderWorkflowReminder(
      {
        onlyNew: true,
        timedPoll: false,
      },
      false,
      'custom poll command',
    );

    const output = info.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).toContain('custom poll command');
    expect(output).not.toContain('tsx scripts/pr-comments.ts --new --timeout 20 <pr-url>');
  });
});
