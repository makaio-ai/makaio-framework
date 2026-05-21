import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '../bus.js';
import { createBusContext } from '../index.js';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';

describe('Hierarchical Namespace Registration', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers two-level hierarchical namespaces', () => {
    const { subjects: TestSubjects } = MakaioBus.registerNamespace(
      createBusNamespace('adapter:claudeCode', {
        initialized: z.object({ timestamp: z.number() }),
      }),
    );

    expect(TestSubjects.initialized.$meta.namespace).toBe('adapter:claudeCode');
    // Subject token has correct runtime string (colons preserved)
    expect(TestSubjects.initialized.subject).toBe('initialized');

    const schema = MakaioBus.getSchema(TestSubjects.initialized);
    expect(schema).toBeDefined();

    // Use returned namespace object for access
    expect(TestSubjects).toHaveProperty('initialized');
  });

  it('registers three-level hierarchical namespaces', () => {
    const { subjects: TestSubjects } = MakaioBus.registerNamespace(
      createBusNamespace('adapter:claudeCode:sdk', {
        thinking: z.object({ content: z.string() }),
      }),
    );

    expect(TestSubjects.thinking.$meta.namespace).toBe('adapter:claudeCode:sdk');
    // Subject token has correct runtime string (colons preserved)
    expect(TestSubjects.thinking.subject).toBe('thinking');

    const schema = MakaioBus.getSchema(TestSubjects.thinking);
    expect(schema).toBeDefined();

    // Use returned namespace object for access
    expect(TestSubjects).toHaveProperty('thinking');
  });

  it('allows extending existing namespaces', () => {
    // Register level 1
    const { subjects: Level1Subjects } = MakaioBus.registerNamespace(
      createBusNamespace('extendable', {
        level1Event: z.object({ data: z.string() }),
      }),
    );

    // Extend to level 2
    const { subjects: Level2Subjects } = MakaioBus.registerNamespace(
      createBusNamespace('extendable:level2', {
        level2Event: z.object({ data: z.string() }),
      }),
    );

    // Extend to level 3
    const { subjects: Level3Subjects } = MakaioBus.registerNamespace(
      createBusNamespace('extendable:level2:level3', {
        level3Event: z.object({ data: z.string() }),
      }),
    );

    // All namespace objects should have their tokens
    expect(Level1Subjects.level1Event).toMatchObject({
      subject: 'level1Event',
      $meta: { namespace: 'extendable' },
    });
    expect(Level2Subjects.level2Event).toMatchObject({
      subject: 'level2Event',
      $meta: { namespace: 'extendable:level2' },
    });
    expect(Level3Subjects.level3Event).toMatchObject({
      subject: 'level3Event',
      $meta: { namespace: 'extendable:level2:level3' },
    });

    const schema = MakaioBus.getSchema(Level1Subjects.level1Event);
    expect(schema).toBeDefined();
  });

  it('allows auto-creating parent namespaces', () => {
    // Register level 3 without explicitly registering levels 1 and 2
    const { subjects: TestSubjects } = MakaioBus.registerNamespace(
      createBusNamespace('auto:parent:child', {
        event: z.object({ data: z.string() }),
      }),
    );

    const schema = MakaioBus.getSchema(TestSubjects.event);
    expect(schema).toBeDefined();

    // Subject accessible via returned namespace object
    expect(TestSubjects.event).toMatchObject({
      subject: 'event',
      $meta: { namespace: 'auto:parent:child' },
    });
  });

  it('emits and receives events using hierarchical subjects', async () => {
    const { subjects: TestSubjects } = MakaioBus.registerNamespace(
      createBusNamespace('hierarchical:test', {
        event: z.object({ message: z.string() }),
      }),
    );

    const received: string[] = [];

    // Subscribe using the returned namespace object
    MakaioBus.on(TestSubjects.event, (context) => {
      received.push(context.payload.message);
    });

    // Emit using the returned namespace object
    await MakaioBus.emit(TestSubjects.event, {
      message: 'Hello from hierarchical namespace!',
    });

    expect(received).toEqual(['Hello from hierarchical namespace!']);
  });

  it('allows idempotent namespace registration', () => {
    const { subjects: first } = MakaioBus.registerNamespace(
      createBusNamespace('duplicate:test', {
        event: z.object({ data: z.string() }),
      }),
    );

    // Re-registering the same namespace should return the existing one
    const { subjects: second } = MakaioBus.registerNamespace(
      createBusNamespace('duplicate:test', {
        event: z.object({ data: z.string() }),
      }),
    );

    // Should return the same namespace object
    expect(second).toMatchObject(first);
    expect(second.event.subject).toBe('event');
  });

  it('does not warn when re-registering identical nested subject schemas', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const context = createBusContext();

    context.namespaceRegistry.registerNamespace(
      createBusNamespace('system', {
        'channel.open': {
          request: z.object({ token: z.string() }),
          response: z.object({ ok: z.boolean() }),
        },
      }),
    );
    context.namespaceRegistry.registerNamespace(
      createBusNamespace('system', {
        'channel.open': {
          request: z.object({ token: z.string() }),
          response: z.object({ ok: z.boolean() }),
        },
      }),
    );

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('stores schemas with colon-preserved keys', () => {
    MakaioBus.registerNamespace(
      createBusNamespace('schema:test', {
        event: z.object({ value: z.number() }),
      }),
    );

    // Schema is now stored with colons in hierarchy, dot before key
    const schema = MakaioBus.getSchema('schema:test.event');
    expect(schema).toBeDefined();

    // Should not find with all-dot notation
    const schemaWithDots = MakaioBus.getSchema('schema.test.event');
    expect(schemaWithDots).toBeUndefined();

    // Should not find with all-colon notation
    const schemaWithAllColons = MakaioBus.getSchema('schema:test:event');
    expect(schemaWithAllColons).toBeUndefined();
  });
});
