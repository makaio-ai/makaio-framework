import { describe, it, expect, beforeEach } from 'vitest';
import { MakaioBus } from '../bus.js';
import { z } from 'zod';
import { createBusNamespace, observability } from '@makaio/core';
import { projectSubjectTelemetryFacts } from '../observability/index.js';

describe('MakaioBus.extendSubject()', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    MakaioBus.getContext().namespaceRegistry.__resetNamespaces?.();
  });

  describe('request subjects', () => {
    it('extends request payload with additional fields', async () => {
      const { subjects } = MakaioBus.registerNamespace(
        createBusNamespace('extSubReq', {
          list: {
            request: z.object({ limit: z.number().optional() }),
            response: z.object({ items: z.array(z.string()), total: z.number() }),
          },
        }),
      );

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
      const { subjects } = MakaioBus.registerNamespace(
        createBusNamespace('extSubVal', {
          get: {
            request: z.object({ id: z.string() }),
            response: z.object({ name: z.string() }),
          },
        }),
      );

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

    it('preserves request schema metadata when extending fields', () => {
      const { subjects } = MakaioBus.registerNamespace(
        createBusNamespace('extSubObs', {
          list: {
            request: observability.schema(
              z.object({
                status: z.string(),
                offset: observability.hidden(z.number().optional()),
              }),
              { traceAll: true },
            ),
            response: z.object({ items: z.array(z.string()) }),
          },
        }),
      );

      MakaioBus.extendSubject(subjects.list, {
        request: { projectId: z.string().optional() },
      });

      const [fact] = projectSubjectTelemetryFacts({
        message: {
          type: 'request',
          namespace: 'extSubObs',
          subject: 'list',
          payload: { status: 'active', offset: 10, projectId: 'proj-1' },
          messageId: 'msg-observable-extension',
          correlationId: 'corr-observable-extension',
        },
        direction: 'local',
        observedAt: 1000,
        namespaceRegistry: MakaioBus.getContext().namespaceRegistry,
      });

      expect(fact.attributes).toEqual({ status: 'active', projectId: 'proj-1' });
    });

    it('extends refined request schemas while preserving base refinements', async () => {
      const { subjects } = MakaioBus.registerNamespace(
        createBusNamespace('extSubRefinedReq', {
          create: {
            request: z.object({ title: z.string() }).superRefine((payload, ctx) => {
              if (payload.title.trim().length === 0) {
                ctx.addIssue({
                  code: 'custom',
                  path: ['title'],
                  message: 'title must not be blank',
                });
              }
            }),
            response: z.object({ id: z.string() }),
          },
        }),
      );

      const extended = MakaioBus.extendSubject(subjects.create, {
        request: { workflowMetadata: z.object({ workflowId: z.string() }).optional() },
      });

      MakaioBus.on(extended, (ctx) => {
        ctx.setResult({ id: ctx.payload.workflowMetadata?.workflowId ?? 'no-workflow' });
      });

      await expect(
        MakaioBus.request(extended, { title: 'factory session', workflowMetadata: { workflowId: 'wf-1' } }),
      ).resolves.toEqual({ id: 'wf-1' });
      await expect(
        MakaioBus.request(extended, { title: '   ', workflowMetadata: { workflowId: 'wf-1' } }),
      ).rejects.toThrow(/title must not be blank/);
    });

    it('allows refined request schemas to redefine fields with later extensions', async () => {
      const { subjects } = MakaioBus.registerNamespace(
        createBusNamespace('extSubRefinedReqOverwrite', {
          create: {
            request: z.object({ title: z.string(), mode: z.string().optional() }).superRefine((payload, ctx) => {
              if (payload.mode === 'blocked') {
                ctx.addIssue({
                  code: 'custom',
                  path: ['mode'],
                  message: 'mode is blocked',
                });
              }
            }),
            response: z.object({ acceptedTitle: z.string() }),
          },
        }),
      );

      const extended = MakaioBus.extendSubject(subjects.create, {
        request: { title: z.literal('factory') },
      });

      MakaioBus.on(extended, (ctx) => {
        ctx.setResult({ acceptedTitle: ctx.payload.title });
      });

      await expect(MakaioBus.request(extended, { title: 'factory' })).resolves.toEqual({ acceptedTitle: 'factory' });
      await expect(MakaioBus.request(extended, { title: 'factory', mode: 'blocked' })).rejects.toThrow(
        /mode is blocked/,
      );
    });

    it('rejects incompatible field overrides on refined request schemas', () => {
      const { subjects } = MakaioBus.registerNamespace(
        createBusNamespace('extSubRefinedReqBadOverwrite', {
          create: {
            request: z.object({ title: z.string() }).superRefine((payload, ctx) => {
              if (payload.title.trim().length === 0) {
                ctx.addIssue({
                  code: 'custom',
                  path: ['title'],
                  message: 'title must not be blank',
                });
              }
            }),
            response: z.object({ id: z.string() }),
          },
        }),
      );

      expect(() => {
        MakaioBus.extendSubject(subjects.create, {
          request: { title: z.number() },
        });
      }).toThrow(/Cannot extend 'extSubRefinedReqBadOverwrite.create' request/);
    });

    it('rejects unmodeled overlapping field overrides on refined request schemas', () => {
      const { subjects } = MakaioBus.registerNamespace(
        createBusNamespace('extSubRefinedReqEnumOverwrite', {
          create: {
            request: z.object({ status: z.enum(['open', 'closed']) }).superRefine((payload, ctx) => {
              if (!payload.status.startsWith('o')) {
                ctx.addIssue({
                  code: 'custom',
                  path: ['status'],
                  message: 'status must start with o',
                });
              }
            }),
            response: z.object({ id: z.string() }),
          },
        }),
      );

      expect(() => {
        MakaioBus.extendSubject(subjects.create, {
          request: { status: z.number() },
        });
      }).toThrow(/Cannot extend 'extSubRefinedReqEnumOverwrite.create' request/);
    });

    it('rejects structural field overrides on refined request schemas', () => {
      const { subjects } = MakaioBus.registerNamespace(
        createBusNamespace('extSubRefinedReqObjectOverwrite', {
          create: {
            request: z.object({ meta: z.object({ id: z.string() }) }).superRefine((payload, ctx) => {
              if (payload.meta.id.trim().length === 0) {
                ctx.addIssue({
                  code: 'custom',
                  path: ['meta', 'id'],
                  message: 'meta id must not be blank',
                });
              }
            }),
            response: z.object({ id: z.string() }),
          },
        }),
      );

      expect(() => {
        MakaioBus.extendSubject(subjects.create, {
          request: { meta: z.object({}) },
        });
      }).toThrow(/Cannot extend 'extSubRefinedReqObjectOverwrite.create' request/);
    });

    it('rejects nested nullish wrapper overrides on refined request schemas', () => {
      const { subjects } = MakaioBus.registerNamespace(
        createBusNamespace('extSubRefinedReqNullishOverwrite', {
          create: {
            request: z.object({ title: z.string().optional() }).superRefine((payload, ctx) => {
              if (payload.title !== undefined && payload.title.trim().length === 0) {
                ctx.addIssue({
                  code: 'custom',
                  path: ['title'],
                  message: 'title must not be blank',
                });
              }
            }),
            response: z.object({ id: z.string() }),
          },
        }),
      );

      expect(() => {
        MakaioBus.extendSubject(subjects.create, {
          request: { title: z.string().nullable().optional() },
        });
      }).toThrow(/Cannot extend 'extSubRefinedReqNullishOverwrite.create' request/);
    });

    it('rejects defaulted field overrides on refined request schemas', () => {
      const { subjects } = MakaioBus.registerNamespace(
        createBusNamespace('extSubRefinedReqDefaultOverwrite', {
          create: {
            request: z.object({ title: z.string().optional().default('fallback') }).superRefine((payload, ctx) => {
              if (payload.title.trim().length === 0) {
                ctx.addIssue({
                  code: 'custom',
                  path: ['title'],
                  message: 'title must not be blank',
                });
              }
            }),
            response: z.object({ id: z.string() }),
          },
        }),
      );

      expect(() => {
        MakaioBus.extendSubject(subjects.create, {
          request: { title: z.string().optional() },
        });
      }).toThrow(/Cannot extend 'extSubRefinedReqDefaultOverwrite.create' request/);
    });

    it('rejects checked primitive field overrides on refined request schemas', () => {
      const { subjects } = MakaioBus.registerNamespace(
        createBusNamespace('extSubRefinedReqCheckedOverwrite', {
          create: {
            request: z.object({ code: z.string().min(2) }).superRefine((payload, ctx) => {
              if (payload.code[1].toUpperCase() !== payload.code[1]) {
                ctx.addIssue({
                  code: 'custom',
                  path: ['code'],
                  message: 'second character must be uppercase',
                });
              }
            }),
            response: z.object({ id: z.string() }),
          },
        }),
      );

      expect(() => {
        MakaioBus.extendSubject(subjects.create, {
          request: { code: z.literal('x') },
        });
      }).toThrow(/Cannot extend 'extSubRefinedReqCheckedOverwrite.create' request/);
    });

    it('original subject still works without extended fields', async () => {
      const { subjects } = MakaioBus.registerNamespace(
        createBusNamespace('extSubOrig', {
          get: {
            request: z.object({ id: z.string() }),
            response: z.object({ name: z.string() }),
          },
        }),
      );

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
      const { subjects } = MakaioBus.registerNamespace(
        createBusNamespace('extSubResp', {
          query: {
            request: z.object({ q: z.string() }),
            response: z.object({ hits: z.number() }),
          },
        }),
      );

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
      const { subjects } = MakaioBus.registerNamespace(
        createBusNamespace('extSubEvt', {
          happened: z.object({ source: z.string() }),
        }),
      );

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
      const { subjects } = MakaioBus.registerNamespace(
        createBusNamespace('extSubMulti', {
          list: {
            request: z.object({ limit: z.number().optional() }),
            response: z.object({ items: z.array(z.string()) }),
          },
        }),
      );

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
      const { subjects } = MakaioBus.registerNamespace(
        createBusNamespace('extSubFw', {
          list: {
            request: z.object({ limit: z.number().optional(), status: z.string().optional() }),
            response: z.object({ count: z.number() }),
          },
        }),
      );

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
      const { subjects } = MakaioBus.registerNamespace(
        createBusNamespace('extSubStrip', {
          get: {
            request: z.object({ id: z.string() }),
            response: z.object({ name: z.string() }),
          },
        }),
      );

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
      const { subjects } = MakaioBus.registerNamespace(
        createBusNamespace('extSubSurvive', {
          get: {
            request: z.object({ id: z.string() }),
            response: z.object({ name: z.string() }),
          },
        }),
      );

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
      const { subjects } = MakaioBus.registerNamespace(
        createBusNamespace('extSubErr', {
          real: {
            request: z.object({ id: z.string() }),
            response: z.object({ ok: z.boolean() }),
          },
        }),
      );

      // Reset namespaces so the subject is no longer registered
      MakaioBus.getContext().namespaceRegistry.__resetNamespaces?.();

      expect(() => {
        MakaioBus.extendSubject(subjects.real, { request: { x: z.string() } });
      }).toThrow(/not registered/);
    });
  });

  describe('routing identity', () => {
    it('extended subject routes to the same bus subject as the original', async () => {
      const { subjects } = MakaioBus.registerNamespace(
        createBusNamespace('extSubRoute', {
          ping: {
            request: z.object({ msg: z.string() }),
            response: z.object({ pong: z.string() }),
          },
        }),
      );

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
