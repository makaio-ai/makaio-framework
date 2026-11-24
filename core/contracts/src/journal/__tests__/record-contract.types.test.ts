import { describe, expect, it } from 'vitest';
import type { MakaioExtension } from '../../extension/makaio-extension.js';
import { JournalError } from '../errors.js';
import type { AcceptEntryInput, JournalAcceptErrorCode, JournalRecordErrorCode, RecordEntryInput } from '../record.js';

/** Never called. The scoped type check verifies the entry input assertions. */
function entryInputAssertions(): void {
  const entry = { subject: 'acme.inbox.received', payload: null, key: 'delivery-1' };
  const witnessed = { extension: 'acme.inbox', site: 'mailbox-1', accountId: 'sender-1' };
  const accepted: AcceptEntryInput = { ...entry, witnessed };

  // @ts-expect-error only the accept input may specify a witnessed account
  const recorded: RecordEntryInput = { ...entry, witnessed };
  void [accepted.witnessed, recorded];
}

/** Never called. The scoped type check verifies the operation-specific error codes. */
function errorCodeAssertions(): void {
  const recordCodes: readonly JournalRecordErrorCode[] = [
    'record-before-active',
    'key-subject-mismatch',
    'foreign-transaction',
    'transaction-finished',
  ];
  const acceptCodes: readonly JournalAcceptErrorCode[] = [
    ...recordCodes,
    'accept-during-own-start',
    'accept-startup-timeout',
    'witnessed-not-owned',
    'cursor-moved',
  ];
  for (const code of acceptCodes) {
    void new JournalError(code, 'Journal write refused');
  }

  // @ts-expect-error the edge owner's startup error is specific to accept
  const startup: JournalRecordErrorCode = 'accept-during-own-start';
  // @ts-expect-error witnessed account ownership is specific to accept
  const ownership: JournalRecordErrorCode = 'witnessed-not-owned';
  // @ts-expect-error cursor movement is specific to accept
  const cursor: JournalRecordErrorCode = 'cursor-moved';
  void [startup, ownership, cursor];
}

/** Never called. The scoped type check verifies both executable manifest contributions. */
function manifestAssertions(): void {
  const manifest: MakaioExtension = {
    name: 'acme.inbox',
    displayName: 'Inbox',
    version: '1.0.0',
    edges: [{ edge: 'acme.inbox.webhook', description: 'Receives mail deliveries', subjects: ['acme.inbox.received'] }],
    accountResolver: {
      resolver: 'acme.inbox.accounts',
      description: 'Maps mailbox accounts',
      resolve: () => Promise.resolve(null),
    },
  };
  void [manifest.edges, manifest.accountResolver];
}

describe('Journal write contracts (type level)', () => {
  it('loads the compile-only assertions', () => {
    expect(typeof entryInputAssertions).toBe('function');
    expect(typeof errorCodeAssertions).toBe('function');
    expect(typeof manifestAssertions).toBe('function');
  });
});
