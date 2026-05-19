import { describe, expect, it } from 'bun:test';
import {
  compareMessageCursorAsc,
  compareMessageCursorDesc,
  messageCursorKey,
  messageToCursor,
} from '../message-cursor.js';

describe('message cursor helpers', () => {
  it('converts messages into deterministic cursors', () => {
    expect(messageToCursor({ timestamp: 1000, messageId: 'msg-a' })).toEqual({
      timestamp: 1000,
      messageId: 'msg-a',
    });
  });

  it('encodes cursors into stable keys', () => {
    expect(messageCursorKey(messageToCursor({ timestamp: 1000, messageId: 'msg-a' }))).toBe('1000:msg-a');
    expect(messageCursorKey(messageToCursor({ timestamp: 2000, messageId: 'msg-b' }))).toBe('2000:msg-b');
  });

  it('sorts cursors ascending by timestamp then messageId', () => {
    const a = { timestamp: 1000, messageId: 'msg-a' };
    const b = { timestamp: 1000, messageId: 'msg-b' };
    const c = { timestamp: 2000, messageId: 'msg-c' };

    expect(compareMessageCursorAsc(a, b)).toBeLessThan(0);
    expect(compareMessageCursorAsc(b, a)).toBeGreaterThan(0);
    expect(compareMessageCursorAsc(b, c)).toBeLessThan(0);
  });

  it('sorts cursors descending by timestamp then messageId', () => {
    const a = { timestamp: 1000, messageId: 'msg-a' };
    const b = { timestamp: 1000, messageId: 'msg-b' };
    const c = { timestamp: 2000, messageId: 'msg-c' };

    expect(compareMessageCursorDesc(a, b)).toBeGreaterThan(0);
    expect(compareMessageCursorDesc(b, a)).toBeLessThan(0);
    expect(compareMessageCursorDesc(c, b)).toBeLessThan(0);
  });
});
