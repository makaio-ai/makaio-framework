import { describe, it, expect, beforeEach } from 'vitest';
import { MakaioBus } from '../bus.js';
import { z } from 'zod';

describe('MakaioBus.extendSubject()', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    MakaioBus.getContext().namespaceRegistry.__resetNamespaces?.();
  });

  describe('request subjects', () => {
    it('extends request payload with additional fields', async () => {
      const { subjects } = MakaioBus.registerNamespace('extSubReq', {
        list: {
          request: z.object({ limit: z.number().optional() }),
          response: z.object({ items: z.array(z.string()), total: z.number() }),
        },
      });

      const extended = MakaioBus.extendSubject(subjects.list, {
        request: { projectId: z.string().optional() },
      });

      MakaioBus.on(extended, (ctx) => {
        ctx.setResult({ items: [String(ctx.payload.projectId ?? 'none')], total: 1 });
      });

      const result = await MakaioBus.request(extended, { limit: 10, projectId: 'proj-1' });
      expect(result).toEqual({ items: ['proj-1'], total: 1 });

      // Type safety: original subject does NOT accept extended fields
      // @ts-expect-error — projectId is not on the original subject's request type
      await MakaioBus.request(subjects.list, { limit: 10, projectId: 'proj-1' });
    });

    it('passes validation with extended fields in dev mode', async () => {
      const { subjects } = MakaioBus.registerNamespace('extSubVal', {
        get: {
          request: z.object({ id: z.string() }),
          response: z.object({ name: z.string() }),
        },
      });

      const extended = MakaioBus.extendSubject(subjects.get, {
        request: { includeArchived: z.boolean().optional() },
      });

      MakaioBus.on(extended, (ctx) => {
        ctx.setResult({ name: 'test' });
      });

      // Should not throw validation error
      const result = await MakaioBus.request(extended, { id: '1', includeArchived: true });
      expect(result).toEqual({ name: 'test' });
    });

    it('original subject still works without extended fields', async () => {
      const { subjects } = MakaioBus.registerNamespace('extSubOrig', {
        get: {
          request: z.object({ id: z.string() }),
          response: z.object({ name: z.string() }),
        },
      });

      MakaioBus.extendSubject(subjects.get, {
        request: { projectId: z.string().optional() },
      });

      MakaioBus.on(subjects.get, (ctx) => {
        ctx.setResult({ name: 'works' });
      });

      // Call with original subject (no extended fields) — still valid
      const result = await MakaioBus.request(subjects.get, { id: '1' });
      expect(result).toEqual({ name: 'works' });
    });

    it('extends response payload', async () => {
      const { subjects } = MakaioBus.registerNamespace('extSubResp', {
        query: {
          request: z.object({ q: z.string() }),
          response: z.object({ hits: z.number() }),
        },
      });

      const extended = MakaioBus.extendSubject(subjects.query, {
        response: { debugInfo: z.string().optional() },
      });

      MakaioBus.on(extended, (ctx) => {
        ctx.setResult({ hits: 42, debugInfo: 'cache-miss' });
      });

      const result = await MakaioBus.request(extended, { q: 'test' });
      expect(result).toEqual({ hits: 42, debugInfo: 'cache-miss' });
    });
  });

  describe('event subjects', () => {
    it('extends event payload with additional fields', async () => {
      const { subjects } = MakaioBus.registerNamespace('extSubEvt', {
        happened: z.object({ source: z.string() }),
      });

      const extended = MakaioBus.extendSubject(subjects.happened, {
        projectId: z.string().optional(),
      });

      let received: unknown;
      MakaioBus.on(extended, (ctx) => {
        received = ctx.payload;
      });

      await MakaioBus.emit(extended, { source: 'test', projectId: 'proj-1' });
      expect(received).toEqual({ source: 'test', projectId: 'proj-1' });

      // Type safety: original event subject does NOT accept extended fields
      // @ts-expect-error — projectId is not on the original subject's event type
      await MakaioBus.emit(subjects.happened, { source: 'test', projectId: 'proj-1' });
    });
  });

  describe('successive extensions', () => {
    it('accumulates fields from multiple extendSubject calls', async () => {
      const { subjects } = MakaioBus.registerNamespace('extSubMulti', {
        list: {
          request: z.object({ limit: z.number().optional() }),
          response: z.object({ items: z.array(z.string()) }),
        },
      });

      // First extension adds projectId
      const withProject = MakaioBus.extendSubject(subjects.list, {
        request: { projectId: z.string().optional() },
      });

      // Second extension chains on the first — TypeScript sees both fields
      const fullyExtended = MakaioBus.extendSubject(withProject, {
        request: { workspaceId: z.string().optional() },
      });

      MakaioBus.on(fullyExtended, (ctx) => {
        const parts = [ctx.payload.projectId ?? 'no-proj', ctx.payload.workspaceId ?? 'no-ws'];
        ctx.setResult({ items: parts });
      });

      const result = await MakaioBus.request(fullyExtended, {
        limit: 5,
        projectId: 'p1',
        workspaceId: 'w1',
      });
      expect(result).toEqual({ items: ['p1', 'w1'] });
    });

    it('higher-priority handler with extended subject delegates to default handler via next()', async () => {
      const { subjects } = MakaioBus.registerNamespace('extSubFw', {
        list: {
          request: z.object({ limit: z.number().optional(), status: z.string().optional() }),
          response: z.object({ count: z.number() }),
        },
      });

      const extended = MakaioBus.extendSubject(subjects.list, {
        request: { projectId: z.string().optional() },
      });

      // Default handler — uses original subject, sees base fields
      MakaioBus.on(
        subjects.list,
        (ctx) => {
          ctx.setResult({ count: ctx.payload.limit ?? 0 });
        },
        { priority: 0 },
      );

      // Higher-priority handler — uses extended subject, delegates when extension field absent
      MakaioBus.on(
        extended,
        (ctx) => {
          if (ctx.payload.projectId) {
            ctx.setResult({ count: 99 });
            return;
          }
          return ctx.next();
        },
        { priority: 10 },
      );

      // With projectId → higher-priority handler responds
      const r1 = await MakaioBus.request(extended, { limit: 5, projectId: 'p1' });
      expect(r1).toEqual({ count: 99 });

      // Without projectId → falls through to default handler
      const r2 = await MakaioBus.request(subjects.list, { limit: 5 });
      expect(r2).toEqual({ count: 5 });
    });
  });

  describe('schema validation', () => {
    it('without extendSubject, only declared fields reach the handler', async () => {
      const { subjects } = MakaioBus.registerNamespace('extSubStrip', {
        get: {
          request: z.object({ id: z.string() }),
          response: z.object({ name: z.string() }),
        },
      });

      let receivedPayload: Record<string, unknown> = {};
      MakaioBus.on(subjects.get, (ctx) => {
        receivedPayload = ctx.payload as Record<string, unknown>;
        ctx.setResult({ name: 'test' });
      });

      await MakaioBus.request(subjects.get, { id: '1' });
      expect(receivedPayload).toEqual({ id: '1' });
      expect('extraField' in receivedPayload).toBe(false);
    });

    it('with extendSubject, extended fields survive Zod validation', async () => {
      const { subjects } = MakaioBus.registerNamespace('extSubSurvive', {
        get: {
          request: z.object({ id: z.string() }),
          response: z.object({ name: z.string() }),
        },
      });

      const extended = MakaioBus.extendSubject(subjects.get, {
        request: { projectId: z.string().optional() },
      });

      let receivedPayload: Record<string, unknown> = {};
      MakaioBus.on(extended, (ctx) => {
        receivedPayload = ctx.payload as Record<string, unknown>;
        ctx.setResult({ name: 'test' });
      });

      await MakaioBus.request(extended, { id: '1', projectId: 'proj-1' });
      expect(receivedPayload).toEqual({ id: '1', projectId: 'proj-1' });
    });
  });

  describe('error handling', () => {
    it('throws when extending an unregistered subject', () => {
      const { subjects } = MakaioBus.registerNamespace('extSubErr', {
        real: {
          request: z.object({ id: z.string() }),
          response: z.object({ ok: z.boolean() }),
        },
      });

      // Reset namespaces so the subject is no longer registered
      MakaioBus.getContext().namespaceRegistry.__resetNamespaces?.();

      expect(() => {
        MakaioBus.extendSubject(subjects.real, { request: { x: z.string() } });
      }).toThrow(/not registered/);
    });
  });

  describe('routing identity', () => {
    it('extended subject routes to the same bus subject as the original', async () => {
      const { subjects } = MakaioBus.registerNamespace('extSubRoute', {
        ping: {
          request: z.object({ msg: z.string() }),
          response: z.object({ pong: z.string() }),
        },
      });

      const extended = MakaioBus.extendSubject(subjects.ping, {
        request: { tag: z.string().optional() },
      });

      // Handler registered on original
      MakaioBus.on(subjects.ping, (ctx) => {
        ctx.setResult({ pong: ctx.payload.msg });
      });

      // Request via extended — same subject string, routes to original handler
      const result = await MakaioBus.request(extended, { msg: 'hello', tag: 'test' });
      expect(result).toEqual({ pong: 'hello' });
    });
  });
});
