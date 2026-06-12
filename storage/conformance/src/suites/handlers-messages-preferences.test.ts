/**
 * Conformance suite: message and preferences storage handler families.
 *
 * Messages:
 * - create→get/list round-trip including content and timestamp fields.
 * - list subject respects its session filter (cross-session isolation).
 *
 * Preferences:
 * - string value: set→get returns identical value; list contains key; delete
 *   removes it and a second get returns the documented miss shape (null).
 * - structured JSON value: set→get returns parsed object (jsonb vs text-JSON
 *   round-trip must be transparent).
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  registerDrizzleSessionStorage,
  registerDrizzleMessageStorage,
  SessionStorageSubjects,
  MessageStorageSubjects,
} from '@makaio/services-core/session';
import { PreferencesSubjects } from '@makaio/services-core/preferences';
import { registerDrizzlePreferencesStorage } from '@makaio/preferences';
import type { SessionMessage } from '@makaio/contracts';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';
import { makeSession } from '../harness/fixture-session.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Payload accepted by MessageStorageSubjects.append (messageId assigned by storage). */
interface AppendMessagePayload {
  /** Message to persist; the storage layer assigns messageId when omitted. */
  message: Omit<SessionMessage, 'messageId'> & { messageId?: string };
  /** Whether to emit a session event for this message. */
  emitEvent?: boolean;
}

/** Fixed preference key shared by all preference round-trip tests. */
const PREF_KEY = { scope: 'global', surface: 'app', context: 'default', viewport: 'desktop' } as const;

/**
 * Minimal message input for the append subject.
 *
 * Pass an explicit `timestamp` when ordering matters: messages are listed by
 * (timestamp, messageId), so same-millisecond appends with random messageIds
 * have no guaranteed relative order.
 * @param sessionId - Session this message belongs to.
 * @param contentText - Message text content.
 * @param role - 'user' or 'assistant'.
 * @param timestamp - Message timestamp (Unix ms). Defaults to now.
 * @returns Payload for MessageStorageSubjects.append.
 */
function makeMessage(
  sessionId: string,
  contentText: string,
  role: 'user' | 'assistant' = 'user',
  timestamp: number = Date.now(),
): AppendMessagePayload {
  return {
    message: {
      turnId: null,
      sessionId,
      role,
      contentText,
      blocks: [{ type: 'text', content: contentText }],
      timestamp,
    },
    emitEvent: false,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeStorageConformance('handlers-messages-preferences', (config) => {
  const getCtx = useSuiteDatabaseContext(config);
  const cleanups: Array<() => void> = [];

  beforeAll(() => {
    // Message handlers require session FK to be satisfied
    cleanups.push(registerDrizzleSessionStorage(MakaioBus, getCtx().db));
    cleanups.push(registerDrizzleMessageStorage(MakaioBus, getCtx().db));
    // Preferences have their own isolated table; no session FK
    cleanups.push(registerDrizzlePreferencesStorage(MakaioBus, getCtx().db));
  });

  afterAll(() => {
    // Handlers unregister first; the context helper's afterAll (registered
    // earlier, therefore run later) releases the database afterwards.
    for (const fn of cleanups.reverse()) {
      fn();
    }
  });

  // ─── Message tests ───────────────────────────────────────────────────────

  describe('message create→get/list', () => {
    it('appended message is retrievable by session', async () => {
      const sessionId = `sess-msg-${crypto.randomUUID()}`;
      const session = makeSession({ sessionId });
      await MakaioBus.request(SessionStorageSubjects.set, { sessionId, session });

      const appendResult = await MakaioBus.request(
        MessageStorageSubjects.append,
        makeMessage(sessionId, 'hello from conformance'),
      );

      expect(appendResult.message).toBeDefined();
      expect(appendResult.message.sessionId).toBe(sessionId);
      expect(appendResult.message.contentText).toBe('hello from conformance');
      expect(appendResult.message.messageId).toBeTruthy();

      const listResult = await MakaioBus.request(MessageStorageSubjects.getBySession, { sessionId });
      expect(listResult.messages).toHaveLength(1);
      expect(listResult.messages[0].contentText).toBe('hello from conformance');
    });

    it('multiple appended messages preserve order and field values', async () => {
      const sessionId = `sess-multi-${crypto.randomUUID()}`;
      const session = makeSession({ sessionId });
      await MakaioBus.request(SessionStorageSubjects.set, { sessionId, session });

      const texts = ['first', 'second', 'third'];
      const base = Date.now();
      for (const [i, text] of texts.entries()) {
        // Distinct timestamps pin the order; same-millisecond appends would
        // fall back to the messageId tie-breaker, which is random here.
        await MakaioBus.request(MessageStorageSubjects.append, makeMessage(sessionId, text, 'user', base + i));
      }

      const listResult = await MakaioBus.request(MessageStorageSubjects.getBySession, { sessionId });
      expect(listResult.messages).toHaveLength(3);
      // Default order is ascending by timestamp+messageId
      const returnedTexts = listResult.messages.map((m) => m.contentText);
      expect(returnedTexts).toEqual(texts);
    });
  });

  describe('message list respects session filter', () => {
    it('messages from session A do not appear when querying session B', async () => {
      const sessionA = `sess-a-${crypto.randomUUID()}`;
      const sessionB = `sess-b-${crypto.randomUUID()}`;
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: sessionA,
        session: makeSession({ sessionId: sessionA }),
      });
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: sessionB,
        session: makeSession({ sessionId: sessionB }),
      });

      await MakaioBus.request(MessageStorageSubjects.append, makeMessage(sessionA, 'session A message'));
      await MakaioBus.request(MessageStorageSubjects.append, makeMessage(sessionB, 'session B message'));

      const aResult = await MakaioBus.request(MessageStorageSubjects.getBySession, { sessionId: sessionA });
      const bResult = await MakaioBus.request(MessageStorageSubjects.getBySession, { sessionId: sessionB });

      expect(aResult.messages).toHaveLength(1);
      expect(aResult.messages[0].contentText).toBe('session A message');
      expect(bResult.messages).toHaveLength(1);
      expect(bResult.messages[0].contentText).toBe('session B message');
    });
  });

  // ─── Preferences tests ───────────────────────────────────────────────────

  describe('preferences — string value round-trip', () => {
    it('set→get returns identical string value', async () => {
      const key = PREF_KEY;
      const category = `cat-str-${crypto.randomUUID()}`;

      await MakaioBus.request(PreferencesSubjects.set, { key, category, value: 'hello-pref' });

      const getResult = await MakaioBus.request(PreferencesSubjects.get, { key, category });
      expect(getResult.value).toBe('hello-pref');
    });

    it('list contains the key after set', async () => {
      const key = PREF_KEY;
      const category = `cat-list-${crypto.randomUUID()}`;

      await MakaioBus.request(PreferencesSubjects.set, { key, category, value: 'listed-value' });

      const listResult = await MakaioBus.request(PreferencesSubjects.list, { key, category });
      expect(listResult.items.length).toBeGreaterThanOrEqual(1);
      const found = listResult.items.find((item) => item.category === category);
      expect(found).toBeDefined();
    });

    it('delete removes the key; subsequent get returns null', async () => {
      const key = PREF_KEY;
      const category = `cat-del-${crypto.randomUUID()}`;

      await MakaioBus.request(PreferencesSubjects.set, { key, category, value: 'to-delete' });
      await MakaioBus.request(PreferencesSubjects.delete, { key, category });

      const getResult = await MakaioBus.request(PreferencesSubjects.get, { key, category });
      expect(getResult.value).toBeNull();
    });
  });

  describe('preferences — structured JSON value round-trip', () => {
    it('set→get returns parsed object equal to the original (jsonb/text-JSON transparent)', async () => {
      const key = PREF_KEY;
      const category = `cat-json-${crypto.randomUUID()}`;
      const value = { theme: 'dark', fontSize: 14, features: ['a', 'b'] };

      await MakaioBus.request(PreferencesSubjects.set, { key, category, value });

      const getResult = await MakaioBus.request(PreferencesSubjects.get, { key, category });
      expect(getResult.value).toEqual(value);
    });
  });
});
