/** Real MCP regression coverage for selected Artifact reads. */

import { afterEach, describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import {
  ArtifactKindRegistrationSchema,
  ArtifactNamespace,
  ArtifactRevisionSchema,
  ArtifactSubjects,
  formatRepoContextKey,
  RepoContextSchema,
  type ArtifactRevision,
  type RepoContext,
} from '@makaio/contracts';
import { ToolRegistry } from '@makaio/services-core/tools';
import { createArtifactQueryToolset, type ArtifactReadHost } from '@makaio/extension-artifact-query';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHttpMcpHandler } from '../server.js';
import { createClient, mountHandler } from './helpers.js';

const repoA = RepoContextSchema.parse({ kind: 'github-cloud', path: 'computeruniverse/ai-factory' });
const repoB = RepoContextSchema.parse({ kind: 'github-cloud', path: 'another-org/another-factory' });
const sharedId = 'shared-decision';
const repoBOnlyId = 'repo-b-only-decision';

const decisionKind = ArtifactKindRegistrationSchema.parse({
  kind: 'decision',
  description: 'Decision used by the MCP selected-read regression.',
  schemaVersion: 1,
  category: 'commitment',
  titlePath: 'subject',
  dataSchema: {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      statement: { type: 'string' },
      rationale: { type: 'string' },
      optionalNote: { type: 'string' },
    },
    required: ['subject', 'statement', 'rationale'],
  },
  views: { compact: { fields: ['subject', 'statement'] } },
});

interface RepositoryFixture {
  readonly context: RepoContext;
  readonly current: ReadonlyMap<string, ArtifactRevision>;
  readonly pinned: ReadonlyMap<string, ArtifactRevision>;
}

function decision(id: string, revision: string, data: Record<string, unknown>): ArtifactRevision {
  return ArtifactRevisionSchema.parse({
    kind: 'decision',
    id,
    revision,
    schemaVersion: 1,
    scope: { level: 'global' },
    data,
    relations: [],
    actor: { kind: 'agent', id: 'mcp-regression' },
    timestamp: 0,
  });
}

function pinnedKey(id: string, revision: string): string {
  return `${id}@${revision}`;
}

function responseData(result: unknown): unknown {
  const parsed = CallToolResultSchema.parse(result);
  const text = parsed.content.find((entry) => entry.type === 'text')?.text;
  if (!text) throw new Error('MCP tool response did not contain JSON text content.');
  return JSON.parse(text) as unknown;
}

function hostContext(context: { readonly turnContext?: Record<string, unknown> }): RepoContext {
  const parsed = RepoContextSchema.safeParse(context.turnContext?.repoContext);
  if (!parsed.success) throw new Error('Selected Artifact reader requires host-provided repository context.');
  return parsed.data;
}

describe('artifacts_read through MCP', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
  });

  it('uses the server-provided host scope for compact, pinned, and unavailable reads', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(ArtifactNamespace);
    const sharedCurrentA = decision(sharedId, 'rev-2', {
      subject: 'Checkout buttons',
      statement: 'Keep checkout buttons blue.',
      rationale: 'The design system requires blue primary actions.',
    });
    const sharedPinnedA = decision(sharedId, 'rev-1', {
      subject: 'Checkout buttons',
      statement: 'Use the existing blue button.',
      rationale: 'The previous approved decision.',
    });
    const repositories: readonly RepositoryFixture[] = [
      {
        context: repoA,
        current: new Map([[sharedId, sharedCurrentA]]),
        pinned: new Map([[pinnedKey(sharedId, 'rev-1'), sharedPinnedA]]),
      },
      {
        context: repoB,
        current: new Map([
          [
            sharedId,
            decision(sharedId, 'rev-2', {
              subject: 'Repo B checkout',
              statement: 'Use an orange checkout button.',
              rationale: 'An unrelated experiment.',
            }),
          ],
          [
            repoBOnlyId,
            decision(repoBOnlyId, 'rev-2', {
              subject: 'Repo B only',
              statement: 'This must not be visible to repo A.',
              rationale: 'It belongs to repo B.',
            }),
          ],
        ]),
        pinned: new Map([
          [
            pinnedKey(sharedId, 'rev-1'),
            decision(sharedId, 'rev-1', {
              subject: 'Repo B checkout',
              statement: 'Use an orange checkout button.',
              rationale: 'An unrelated experiment.',
            }),
          ],
          [
            pinnedKey(repoBOnlyId, 'rev-1'),
            decision(repoBOnlyId, 'rev-1', {
              subject: 'Repo B only',
              statement: 'This must not be visible to repo A.',
              rationale: 'It belongs to repo B.',
            }),
          ],
        ]),
      },
    ];
    const repositoryFor = (context: RepoContext): RepositoryFixture | undefined =>
      repositories.find((repository) => formatRepoContextKey(repository.context) === formatRepoContextKey(context));
    const receivedScopes: RepoContext[] = [];

    const scopedKindList = bus.extendSubject(ArtifactSubjects.kind.list, {
      request: { repoContext: RepoContextSchema },
    });
    const scopedQuery = bus.extendSubject(ArtifactSubjects.query, {
      request: { repoContext: RepoContextSchema },
    });
    const scopedResolve = bus.extendSubject(ArtifactSubjects.resolve, {
      request: { repoContext: RepoContextSchema },
    });
    const unregisterKindList = bus.on(scopedKindList, (context) => {
      receivedScopes.push(context.payload.repoContext);
      context.setResult({ kinds: repositoryFor(context.payload.repoContext) ? [decisionKind] : [] });
    });
    const unregisterQuery = bus.on(scopedQuery, (context) => {
      receivedScopes.push(context.payload.repoContext);
      const repository = repositoryFor(context.payload.repoContext);
      const artifacts =
        context.payload.ids
          ?.map((id) => repository?.current.get(id))
          .filter((artifact): artifact is ArtifactRevision => artifact !== undefined) ?? [];
      context.setResult({ artifacts });
    });
    const unregisterResolve = bus.on(scopedResolve, (context) => {
      receivedScopes.push(context.payload.repoContext);
      const repository = repositoryFor(context.payload.repoContext);
      context.setResult({
        artifact: repository?.pinned.get(pinnedKey(context.payload.ref.id, context.payload.ref.revision)) ?? null,
      });
    });

    const registry = new ToolRegistry({ bus });
    const host: ArtifactReadHost = {
      async listKinds(kind, context) {
        const response = await bus.request(scopedKindList, { kind, repoContext: hostContext(context) });
        return response.kinds;
      },
      async resolveCurrent(ref, context) {
        const response = await bus.request(scopedQuery, {
          kind: ref.kind,
          ids: [ref.id],
          currentOnly: true,
          limit: 2,
          repoContext: hostContext(context),
        });
        return response.artifacts[0] ?? null;
      },
      async resolvePinned(ref, context) {
        const response = await bus.request(scopedResolve, { ref, repoContext: hostContext(context) });
        return response.artifact;
      },
    };
    await registry.register(createArtifactQueryToolset(host));
    const handle = await createHttpMcpHandler(bus, {
      resolveContextOverrides: () => ({ turnContext: { repoContext: repoA } }),
    });
    const mounted = await mountHandler(handle.handler);
    cleanups.push(async () => {
      unregisterResolve();
      unregisterQuery();
      unregisterKindList();
      registry.dispose();
      await handle.close();
      await mounted.stop();
    });

    const { client, transport } = await createClient(mounted.port);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('artifacts_read');
      const result = await client.callTool({
        name: 'artifacts_read',
        arguments: {
          purpose: 'I am checking current decisions before implementation.',
          reads: [
            { ref: { kind: 'decision', id: sharedId } },
            { ref: { kind: 'decision', id: sharedId, revision: 'rev-1' }, fields: ['rationale', 'optionalNote'] },
            { ref: { kind: 'decision', id: repoBOnlyId } },
            { ref: { kind: 'decision', id: repoBOnlyId, revision: 'rev-1' } },
          ],
        },
      });

      expect(result.isError).not.toBe(true);
      expect(responseData(result)).toEqual({
        results: [
          {
            ok: true,
            ref: { refClass: 'artifact', kind: 'decision', id: sharedId, revision: 'rev-2' },
            title: 'Checkout buttons',
            data: { subject: 'Checkout buttons', statement: 'Keep checkout buttons blue.' },
            selection: { mode: 'view', view: 'compact', fields: ['subject', 'statement'], omittedAbsentFields: [] },
          },
          {
            ok: true,
            ref: { refClass: 'artifact', kind: 'decision', id: sharedId, revision: 'rev-1' },
            title: 'Checkout buttons',
            data: { rationale: 'The previous approved decision.' },
            selection: {
              mode: 'fields',
              fields: ['rationale', 'optionalNote'],
              omittedAbsentFields: ['optionalNote'],
            },
          },
          {
            ok: false,
            ref: { kind: 'decision', id: repoBOnlyId },
            error: { code: 'ARTIFACT_NOT_FOUND', message: `Artifact 'decision:${repoBOnlyId}' was not found.` },
          },
          {
            ok: false,
            ref: { kind: 'decision', id: repoBOnlyId, revision: 'rev-1' },
            error: { code: 'ARTIFACT_NOT_FOUND', message: `Artifact 'decision:${repoBOnlyId}' was not found.` },
          },
        ],
      });
      expect(receivedScopes).toHaveLength(5);
      expect(receivedScopes.every((scope) => formatRepoContextKey(scope) === formatRepoContextKey(repoA))).toBe(true);
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it('returns a structured MCP error instead of accepting an invalid selector', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(ArtifactNamespace);
    const registry = new ToolRegistry({ bus });
    const host: ArtifactReadHost = {
      listKinds: async () => [],
      resolveCurrent: async () => null,
      resolvePinned: async () => null,
    };
    await registry.register(createArtifactQueryToolset(host));
    const handle = await createHttpMcpHandler(bus, {
      resolveContextOverrides: () => ({ turnContext: { repoContext: repoA } }),
    });
    const mounted = await mountHandler(handle.handler);
    cleanups.push(async () => {
      registry.dispose();
      await handle.close();
      await mounted.stop();
    });

    const { client, transport } = await createClient(mounted.port);
    try {
      const result = await client.callTool({
        name: 'artifacts_read',
        arguments: {
          purpose: 'I am checking a decision.',
          reads: [{ ref: { kind: 'decision', id: sharedId }, view: 'compact', fields: ['statement'] }],
        },
      });

      expect(result.isError).toBe(true);
      expect(responseData(result)).toMatchObject({ code: 'VALIDATION_FAILED', message: 'Input validation failed' });
    } finally {
      await client.close();
      await transport.close();
    }
  });
});
