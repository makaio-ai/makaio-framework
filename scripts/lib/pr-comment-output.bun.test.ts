import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { renderReviewEntries, renderWorkflowReminder } from './pr-comment-output.js';

describe('renderReviewEntries', () => {
  afterEach(() => {
    mock.restore();
  });

  it('strips terminal control sequences from untrusted comment text', () => {
    const info = spyOn(console, 'info').mockImplementation(() => undefined);

    renderReviewEntries(
      [
        {
          state: 'COMMENTED',
          author: 'reviewer',
          body: 'safe[31mred[0m',
        },
      ],
      [
        {
          path: 'src/[31mfile.ts',
          line: 4,
          startLine: null,
          author: 'bot',
          body: 'body[2J',
          inReplyToId: null,
        },
      ],
    );

    const output = info.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).not.toContain('');
    expect(output).not.toContain('');
  });
});

describe('renderWorkflowReminder', () => {
  afterEach(() => {
    mock.restore();
  });

  it('prints the caller-provided post-push command instead of a hardcoded workspace command', () => {
    const info = spyOn(console, 'info').mockImplementation(() => undefined);

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
