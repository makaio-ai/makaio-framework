import { describe, expect, it } from 'vitest';
import { CODE_EXECUTION_FAILURE_MESSAGE_MAX_LENGTH } from '@makaio/contracts';
import { REDACTION_PLACEHOLDER, sanitizeDiagnosticMessage } from '../types.js';

// The sanitizer is the last thing a diagnostic passes through before it can
// reach a bounded contract failure, on both sides of the thread boundary. These
// cases pin the property that makes it worth anything: a value handed to it as
// a redaction must not survive in the message, whatever shape it arrives in.

describe('sanitizeDiagnosticMessage', () => {
  it('folds an embedded stack trace onto one line', () => {
    const sanitized = sanitizeDiagnosticMessage('Error: boom\n    at handler\n    at run', []);

    expect(sanitized).toBe('Error: boom at handler at run');
  });

  it('reports a summary for a message that collapses to nothing', () => {
    expect(sanitizeDiagnosticMessage('   \n\t ', [])).toBe('No diagnostic detail available.');
  });

  it('bounds a long message to the contract limit', () => {
    const sanitized = sanitizeDiagnosticMessage('x'.repeat(CODE_EXECUTION_FAILURE_MESSAGE_MAX_LENGTH * 2), []);

    expect(sanitized.length).toBeLessThanOrEqual(CODE_EXECUTION_FAILURE_MESSAGE_MAX_LENGTH);
  });

  // The message is collapsed before matching, so a redaction still carrying its
  // original tab, newline, or double space can no longer occur in it. Matching
  // it unchanged would let the value cross the bus in the one spelling that
  // survives the collapse.
  it.each([
    'secret\tvalue',
    'secret  value',
    'secret\nvalue',
  ])('redacts %j although the collapse rewrote its whitespace', (redaction) => {
    const sanitized = sanitizeDiagnosticMessage(`Error: token=${redaction} was rejected`, [redaction]);

    expect(sanitized).toBe(`Error: token=${REDACTION_PLACEHOLDER} was rejected`);
    expect(sanitized).not.toContain('value');
  });

  // The realistic shape of the case above: a configured environment value that
  // is a PEM block carries internal newlines, indentation, and repeated spaces
  // all at once. Every one of those runs is rewritten by the collapse, so this
  // pins the whole value — not one whitespace kind at a time.
  it('redacts a multi-line PEM-shaped value across every whitespace run it carries', () => {
    const pem = ['-----BEGIN PRIVATE KEY-----', '  MIIB  aGVsbG8=', '\tZm9vYmFy', '-----END PRIVATE KEY-----'].join(
      '\n',
    );

    const sanitized = sanitizeDiagnosticMessage(`Error: failed to parse ${pem} from SIGNING_KEY`, [pem]);

    expect(sanitized).toBe(`Error: failed to parse ${REDACTION_PLACEHOLDER} from SIGNING_KEY`);
    expect(sanitized).not.toContain('MIIB');
    expect(sanitized).not.toContain('Zm9vYmFy');
  });

  it('applies the longest redaction first so a prefix cannot partially replace it', () => {
    const sanitized = sanitizeDiagnosticMessage('/tmp/root/entry.ts failed', ['/tmp/root', '/tmp/root/entry.ts']);

    expect(sanitized).toBe(`${REDACTION_PLACEHOLDER} failed`);
  });

  it('orders redactions by their collapsed length, not their raw length', () => {
    // Raw, the shorter string is the longer one: nine characters of whitespace
    // make `/tmp/a` look longer than the path that contains it. Ordering on the
    // raw length would replace the prefix first and leave `/entry.ts` behind.
    const sanitized = sanitizeDiagnosticMessage('/tmp/a/entry.ts failed', ['/tmp/a          ', '/tmp/a/entry.ts']);

    expect(sanitized).toBe(`${REDACTION_PLACEHOLDER} failed`);
  });

  it('ignores a redaction that collapses to nothing instead of splitting the message apart', () => {
    const sanitized = sanitizeDiagnosticMessage('Error: boom', ['', '   ']);

    expect(sanitized).toBe('Error: boom');
  });
});
