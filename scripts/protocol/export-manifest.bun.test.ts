import { MakaioBus } from '@makaio/bus-core';
import { createBusNamespace } from '@makaio/core';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  FrameworkContractNamespaces,
  FrameworkStorageNamespaces,
} from '../../packages/contracts/src/namespace-catalog.js';
import {
  defaultRustModelChecker,
  auditProtocolExport,
  discoverRegisteredProtocolSubjects,
  exportProtocolManifest,
} from './export-manifest.js';

MakaioBus.registerNamespaces(FrameworkContractNamespaces);
MakaioBus.registerNamespaces(FrameworkStorageNamespaces);
import { PublicProtocolNamespaces } from '../../packages/contracts/src/protocol/index.js';
import type {
  JsonObject,
  MakaioProtocolManifest,
  MakaioProtocolSubject,
  ProtocolNamespaceCatalog,
  RustModelRepresentabilityChecker,
} from '../../packages/contracts/src/protocol/index.js';

function getSubject(manifest: MakaioProtocolManifest, fullSubject: string): MakaioProtocolSubject {
  const subject = manifest.subjects.find((entry) => entry.fullSubject === fullSubject);
  if (!subject) {
    throw new Error(`Expected manifest subject ${fullSubject}`);
  }
  return subject;
}

function getEmbeddedSchemas(subject: MakaioProtocolSubject): JsonObject[] {
  if (subject.kind === 'request') {
    return [subject.requestSchema, subject.responseSchema];
  }

  return [subject.payloadSchema];
}

describe('protocol manifest export', () => {
  it('discovers registered subject metadata from the runtime namespace registry', () => {
    const subjects = discoverRegisteredProtocolSubjects();

    expect(subjects.find((subject) => subject.fullSubject === 'credential.getChannelToken')).toMatchObject({
      namespace: 'credential',
      subject: 'getChannelToken',
      local: true,
      channel: false,
    });
    expect(subjects.find((subject) => subject.fullSubject === 'credential.store')).toMatchObject({
      namespace: 'credential',
      subject: 'store',
      local: false,
      channel: true,
    });
  });

  it('exports all clean registered subjects in auto-discovery mode', () => {
    const manifest = exportProtocolManifest();

    expect(manifest.version).toBe(2);

    // Known public namespaces must all be present.
    const namespaces = new Set(manifest.subjects.map((subject) => subject.namespace));
    expect(namespaces.has('agent')).toBe(true);
    expect(namespaces.has('approval')).toBe(true);
    expect(namespaces.has('session')).toBe(true);
    expect(namespaces.has('tool')).toBe(true);

    // Subjects must be sorted deterministically — verified fully by the drift test.

    // Spot-check well-known subjects.
    expect(getSubject(manifest, 'agent.started').kind).toBe('event');
    expect(getSubject(manifest, 'approval.request').kind).toBe('request');
    expect(getSubject(manifest, 'tool.execute').kind).toBe('request');

    // z.custom() subjects must be silently excluded.
    expect(manifest.subjects.some((s) => s.fullSubject === 'storage:adapter.get')).toBe(false);
    expect(manifest.subjects.some((s) => s.fullSubject === 'storage:adapter.set')).toBe(false);
  });

  it('publishes only the public session subset in catalog mode', () => {
    const manifest = exportProtocolManifest({ catalog: PublicProtocolNamespaces });
    const sessionSubjects = manifest.subjects
      .filter((subject) => subject.namespace === 'session')
      .map((subject) => subject.fullSubject);

    expect(sessionSubjects).toEqual([
      'session.agent.added',
      'session.created',
      'session.sendMessage',
      'session.turn.completed',
      'session.turn.started',
      'session.user_message.sent',
    ]);
  });

  it('exports a truthful public session agent contract for canonical-model selections', () => {
    const manifest = exportProtocolManifest({ catalog: PublicProtocolNamespaces });
    const sendMessage = getSubject(manifest, 'session.sendMessage');
    expect(sendMessage.kind).toBe('request');

    if (sendMessage.kind !== 'request') {
      return;
    }

    const requestSchema = sendMessage.requestSchema as JsonObject & {
      properties?: { agent?: JsonObject };
    };
    const agentSchema = requestSchema.properties?.agent as JsonObject & {
      anyOf?: JsonObject[];
    };

    expect(agentSchema.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            kind: expect.objectContaining({ const: 'canonical-model' }),
            model: expect.objectContaining({ minLength: 1, type: 'string' }),
          }),
          required: expect.arrayContaining(['kind', 'model']),
        }),
        expect.objectContaining({
          properties: expect.objectContaining({
            kind: expect.objectContaining({ pattern: '^(?!(?:adapter|canonical-model)$).+$' }),
          }),
        }),
      ]),
    );
  });

  it('strips embedded JSON Schema dialect markers while preserving bus metadata', () => {
    const manifest = exportProtocolManifest();
    const toolExecute = getSubject(manifest, 'tool.execute');

    expect(toolExecute.local).toBe(false);
    expect(toolExecute.channel).toBe(false);

    for (const schema of getEmbeddedSchemas(toolExecute)) {
      expect(schema).not.toHaveProperty('$schema');
    }
  });

  it('audits all registered subjects in auto-discovery mode with no blocking issues', () => {
    const audit = auditProtocolExport();

    // Auto-discovery is non-blocking — issues array must always be empty.
    expect(audit.issues).toEqual([]);

    // Known-clean subjects must have passed status on both checks.
    const toolExecute = audit.subjects.find((subject) => subject.fullSubject === 'tool.execute');
    expect(toolExecute).toMatchObject({
      jsonSchema: { status: 'passed' },
      rustModel: { status: 'passed' },
    });

    // Auto-discovery only reports currently registered subjects, and all
    // registered subjects must export cleanly.
    expect(audit.subjects.every((subject) => subject.jsonSchema.status === 'passed')).toBe(true);
  });

  it('rejects schemas with non-representable Rust patterns using the default checker', () => {
    const result = defaultRustModelChecker({
      kind: 'event',
      namespace: 'protocol-manifest-rust-not-check',
      subject: 'withNot',
      fullSubject: 'protocol-manifest-rust-not-check.withNot',
      local: false,
      channel: false,
      payloadSchema: {
        not: {},
      },
    });

    expect(result).toEqual({
      status: 'failed',
      message: "payloadSchema: 'not' keyword cannot be represented as a Rust type",
    });
  });

  it('fails export with the affected subject when a Rust model checker rejects a selected schema', () => {
    const rustModelChecker: RustModelRepresentabilityChecker = (subject) =>
      subject.fullSubject === 'tool.execute'
        ? { status: 'failed', message: 'unsupported generated Rust shape' }
        : { status: 'passed' };

    const audit = auditProtocolExport({ catalog: PublicProtocolNamespaces, rustModelChecker });

    expect(audit.issues).toContainEqual({
      namespace: 'tool',
      subject: 'execute',
      fullSubject: 'tool.execute',
      check: 'rustModel',
      message: 'unsupported generated Rust shape',
    });
    expect(() => exportProtocolManifest({ catalog: PublicProtocolNamespaces, rustModelChecker })).toThrow(
      /tool\.execute \[rustModel\]: unsupported generated Rust shape/,
    );
  });

  it('reports the affected namespace and subject when JSON Schema export fails in catalog mode', () => {
    const namespace = 'protocol-manifest-json-schema-failure';
    const schemas = {
      get: z.custom(),
    };
    // Catalog mode only inspects the explicit `catalog` below. This uniquely
    // named z.custom() namespace is also skipped by auto-discovery export, so
    // there is no behavior change for the auto-discovery assertions above.
    MakaioBus.registerNamespace(createBusNamespace(namespace, schemas));

    const catalog = [
      {
        namespace,
        schemas,
        subjects: ['get'],
      },
    ] satisfies ProtocolNamespaceCatalog;

    const audit = auditProtocolExport({ catalog });

    expect(audit.issues).toHaveLength(1);
    const issue = audit.issues[0];
    if (!issue) {
      throw new Error('Expected JSON Schema export failure issue');
    }

    expect(issue).toMatchObject({
      namespace,
      subject: 'get',
      fullSubject: `${namespace}.get`,
      check: 'jsonSchema',
      message: expect.stringContaining(`Failed to export JSON Schema for ${namespace}.get`),
    });
    expect(() => exportProtocolManifest({ catalog })).toThrow(
      `${namespace}.get [jsonSchema]: Failed to export JSON Schema for ${namespace}.get`,
    );
  });

  it('rejects duplicate explicit catalog subjects', () => {
    const namespace = 'protocol-manifest-duplicate-subject';
    const schemas = {
      event: z.object({ id: z.string() }),
    };

    const catalog = [
      {
        namespace,
        schemas,
        subjects: ['event', 'event'],
      },
    ] satisfies ProtocolNamespaceCatalog;

    expect(() => auditProtocolExport({ catalog })).toThrow(
      `Duplicate protocol catalog subject for ${namespace}: event`,
    );
    expect(() => exportProtocolManifest({ catalog })).toThrow(
      `Duplicate protocol catalog subject for ${namespace}: event`,
    );
  });
});
