import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import '@makaio/contracts';
import { describe, expect, it } from 'vitest';
import { PublicProtocolNamespaces } from '../../packages/contracts/src/protocol/catalog.js';
import type { MakaioProtocolManifest, MakaioProtocolSubject } from '../../packages/contracts/src/protocol/types.js';
import { exportProtocolManifest } from '../../packages/contracts/src/protocol/index.js';
import { PYTHON_GENERATED_DIR, PYTHON_PAYLOADS_DIR, PYTHON_SUBJECTS_PATH } from '../lib/sdk-generation-paths.js';
import { generatePythonNamespaceModule, generatePythonSubjects, toPythonConstantName } from './python.js';
import { generatePythonPayloadsModule, groupByNamespace } from './python-payloads.js';

function normalizeNewlines(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

describe('Python subject bindings generation', () => {
  it('matches the committed generated subjects module', async () => {
    const manifest = exportProtocolManifest({ catalog: PublicProtocolNamespaces });
    const committedSubjects = normalizeNewlines(await readFile(PYTHON_SUBJECTS_PATH, 'utf8'));
    const generatedSubjects = normalizeNewlines(generatePythonSubjects(manifest));

    expect(committedSubjects).toBe(generatedSubjects);
  });

  it('fails loudly when different subjects collapse to the same Python constant name', () => {
    const manifest = {
      version: 2,
      subjects: [
        {
          kind: 'event',
          namespace: 'storage',
          subject: 'adapter.get',
          fullSubject: 'storage.adapter.get',
          local: false,
          channel: false,
          payloadSchema: {},
        },
        {
          kind: 'event',
          namespace: 'storage_adapter',
          subject: 'get',
          fullSubject: 'storage_adapter.get',
          local: false,
          channel: false,
          payloadSchema: {},
        },
      ],
    } satisfies MakaioProtocolManifest;

    expect(toPythonConstantName('storage.adapter.get')).toBe(toPythonConstantName('storage_adapter.get'));
    expect(() => generatePythonSubjects(manifest)).toThrow('Python subject constant collision');
  });
});

describe('Python namespace module generation', () => {
  it('matches the committed generated namespace modules', async () => {
    const manifest = exportProtocolManifest({ catalog: PublicProtocolNamespaces });
    const groups = groupByNamespace(manifest.subjects);
    const namespaceFiles = (await readdir(PYTHON_GENERATED_DIR))
      .filter((name) => name.endsWith('.py') && name !== '__init__.py' && name !== 'subjects.py')
      .sort();

    expect(namespaceFiles).toEqual([...groups.keys()].sort().map((namespace) => `${namespace}.py`));

    for (const namespaceFile of namespaceFiles) {
      const namespace = namespaceFile.replace(/\.py$/, '');
      const committed = normalizeNewlines(await readFile(resolve(PYTHON_GENERATED_DIR, namespaceFile), 'utf8'));
      const generated = normalizeNewlines(generatePythonNamespaceModule(namespace, groups.get(namespace) ?? []));

      expect(committed).toBe(generated);
    }

    const committedInit = normalizeNewlines(await readFile(resolve(PYTHON_GENERATED_DIR, '__init__.py'), 'utf8'));
    const expectedInit = [
      '"""Generated namespace modules — re-export for convenient access."""',
      '',
      `from makaio.generated import ${[...groups.keys()].sort().join(', ')}`,
      '',
    ].join('\n');

    expect(committedInit).toBe(expectedInit);
  });

  it('passes payload, request, and response types to runtime subject descriptors', () => {
    const subjects = [
      {
        kind: 'event',
        namespace: 'agent',
        subject: 'complete',
        fullSubject: 'agent.complete',
        local: false,
        channel: false,
        payloadSchema: { type: 'object', properties: {} },
      },
      {
        kind: 'request',
        namespace: 'agent',
        subject: 'sendMessage',
        fullSubject: 'agent.sendMessage',
        local: false,
        channel: false,
        requestSchema: { type: 'object', properties: {} },
        responseSchema: { type: 'object', properties: {} },
      },
    ] satisfies MakaioProtocolSubject[];

    const source = generatePythonNamespaceModule('agent', subjects);

    expect(source).toContain(
      'complete: EventSubject[AgentCompletePayload] = EventSubject("agent.complete", payload_type=AgentCompletePayload)',
    );
    expect(source).toContain(
      'send_message: RequestSubject[AgentSendMessageRequest, AgentSendMessageResponse] = RequestSubject("agent.sendMessage", request_type=AgentSendMessageRequest, response_type=AgentSendMessageResponse)',
    );
  });
});

describe('Python payload generation', () => {
  it('matches the committed generated payload modules', async () => {
    const manifest = exportProtocolManifest({ catalog: PublicProtocolNamespaces });
    const groups = groupByNamespace(manifest.subjects);
    const payloadFiles = (await readdir(PYTHON_PAYLOADS_DIR)).filter((name) => name.endsWith('.py')).sort();

    expect(payloadFiles).toEqual(['__init__.py', ...[...groups.keys()].sort().map((namespace) => `${namespace}.py`)]);

    const committedInit = normalizeNewlines(await readFile(resolve(PYTHON_PAYLOADS_DIR, '__init__.py'), 'utf8'));
    expect(committedInit).toBe('"""Payload dataclass modules — generated from makaio-bus-protocol.json."""\n');

    for (const payloadFile of payloadFiles.filter((name) => name !== '__init__.py')) {
      const namespace = payloadFile.replace(/\.py$/, '');
      const committed = normalizeNewlines(await readFile(resolve(PYTHON_PAYLOADS_DIR, payloadFile), 'utf8'));
      const generated = normalizeNewlines(generatePythonPayloadsModule(namespace, groups.get(namespace) ?? []));

      expect(committed).toBe(generated);
    }
  });

  it('generates nested dataclasses for typed object properties and oneOf object variants', () => {
    const subjects = [
      {
        kind: 'event',
        namespace: 'demo',
        subject: 'nested',
        fullSubject: 'demo.nested',
        local: false,
        channel: false,
        payloadSchema: {
          type: 'object',
          required: ['choice', 'metadata'],
          properties: {
            metadata: {
              type: 'object',
              required: ['kind'],
              properties: {
                count: { type: 'integer' },
                kind: { enum: ['meta'] },
              },
            },
            choice: {
              oneOf: [
                {
                  type: 'object',
                  required: ['kind', 'text'],
                  properties: {
                    kind: { const: 'text' },
                    text: { type: 'string' },
                  },
                },
                {
                  type: 'object',
                  required: ['count', 'kind'],
                  properties: {
                    count: { type: 'integer' },
                    kind: { const: 'count' },
                  },
                },
              ],
            },
            label: { type: 'string' },
          },
        },
      },
    ] satisfies MakaioProtocolSubject[];

    const source = generatePythonPayloadsModule('demo', subjects);

    expect(source).toContain('from typing import Literal, Union');
    expect(source).toContain('class DemoNestedPayloadChoiceVariantA:');
    expect(source).toContain('    kind: Literal["text"]');
    expect(source).toContain('    text: str');
    expect(source).toContain('class DemoNestedPayloadChoiceVariantB:');
    expect(source).toContain('    count: int');
    expect(source).toContain('    kind: Literal["count"]');
    expect(source).toContain('class DemoNestedPayloadMetadata:');
    expect(source).toContain('    kind: Literal["meta"]');
    expect(source).toContain('    count: int | None = None');
    expect(source).toContain('class DemoNestedPayload:');
    expect(source).toContain('    choice: Union[DemoNestedPayloadChoiceVariantA, DemoNestedPayloadChoiceVariantB]');
    expect(source).toContain('    metadata: DemoNestedPayloadMetadata');
    expect(source).toContain('    label: str | None = None');
  });

  it('falls back for typed objects with wire keys that cannot round-trip as Python fields', () => {
    const subjects = [
      {
        kind: 'event',
        namespace: 'demo',
        subject: 'unsafeKeys',
        fullSubject: 'demo.unsafeKeys',
        local: false,
        channel: false,
        payloadSchema: {
          type: 'object',
          required: ['levels'],
          properties: {
            levels: {
              type: 'object',
              properties: {
                high: { type: 'boolean' },
                'extra-high': { type: 'boolean' },
              },
            },
          },
        },
      },
    ] satisfies MakaioProtocolSubject[];

    const source = generatePythonPayloadsModule('demo', subjects);

    expect(source).toContain('from typing import Any');
    expect(source).not.toContain('class DemoUnsafeKeysPayloadLevels:');
    expect(source).toContain('    levels: dict[str, Any]');
  });
});
