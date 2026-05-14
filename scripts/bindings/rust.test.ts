import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PublicProtocolNamespaces } from '../../packages/contracts/src/protocol/catalog.js';
import { exportProtocolManifest } from '../protocol/export-manifest.js';
import type { MakaioProtocolManifest } from '../../packages/contracts/src/protocol/types.js';
import { RUST_SUBJECTS_PATH } from '../lib/sdk-generation-paths.js';
import {
  extractHandAuthoredSection,
  generateRustSubjectsSection,
  toRustConstantName,
  toRustModuleName,
} from './rust.js';

const TEST_MANIFEST = {
  version: 2,
  subjects: [
    {
      kind: 'event',
      namespace: 'agent',
      subject: 'message',
      fullSubject: 'agent.message',
      local: false,
      channel: false,
      payloadSchema: {},
    },
  ],
} satisfies MakaioProtocolManifest;

describe('Rust subject bindings generation', () => {
  it('wraps the generated Rust section with explicit preservation markers', () => {
    const content = generateRustSubjectsSection(TEST_MANIFEST);

    expect(content).toContain('// <generated-subjects>');
    expect(content).toContain('// </generated-subjects>');
    expect(content.indexOf('// <generated-subjects>')).toBeLessThan(content.indexOf('// </generated-subjects>'));
  });

  it('preserves hand-authored Rust content after the generated section end marker', () => {
    const existingContent =
      '// <generated-subjects>\npub const SUBJECTS: &[()] = &[];\n// </generated-subjects>\n\npub struct HandAuthored;\n';

    expect(extractHandAuthoredSection(existingContent)).toBe('\npub struct HandAuthored;\n');
  });

  it('accepts generated-section markers in CRLF files', () => {
    const existingContent =
      '// <generated-subjects>\r\npub const SUBJECTS: &[()] = &[];\r\n// </generated-subjects>\r\n\r\npub struct HandAuthored;\r\n';

    expect(extractHandAuthoredSection(existingContent)).toBe('\r\npub struct HandAuthored;\r\n');
  });

  it('fails loudly when existing Rust subjects content is missing generated-section markers', () => {
    expect(() => extractHandAuthoredSection('pub const SUBJECTS: &[()] = &[];\n')).toThrow(
      'Missing generated section markers in Rust subjects file',
    );
  });

  it('fails loudly when an extra generated-section start marker appears after the generated block', () => {
    const malformedContent =
      '// <generated-subjects>\npub const SUBJECTS: &[()] = &[];\n// </generated-subjects>\n// <generated-subjects>\n';

    expect(() => extractHandAuthoredSection(malformedContent)).toThrow(
      'Unexpected generated section marker after Rust subjects generated section',
    );
  });

  it('does not prefix uppercase-leading subjects with a separator', () => {
    expect(toRustConstantName('Message')).toBe('MESSAGE');
  });

  it('escapes reserved Rust keywords in module names', () => {
    expect(toRustModuleName('try')).toBe('r#try');
    expect(toRustModuleName('macro')).toBe('r#macro');
  });

  it('fails loudly when namespaces collapse to the same Rust module name', () => {
    const manifest = {
      version: 2,
      subjects: [
        {
          kind: 'event',
          namespace: 'storage:adapter',
          subject: 'created',
          fullSubject: 'storage:adapter.created',
          local: false,
          channel: false,
          payloadSchema: {},
        },
        {
          kind: 'event',
          namespace: 'storage.adapter',
          subject: 'updated',
          fullSubject: 'storage.adapter.updated',
          local: false,
          channel: false,
          payloadSchema: {},
        },
      ],
    } satisfies MakaioProtocolManifest;

    expect(() => generateRustSubjectsSection(manifest)).toThrow('Rust module identifier collision');
  });

  it('fails loudly when subject names collapse to the same Rust constant name', () => {
    const manifest = {
      version: 2,
      subjects: [
        {
          kind: 'event',
          namespace: 'agent',
          subject: 'foo.bar',
          fullSubject: 'agent.foo.bar',
          local: false,
          channel: false,
          payloadSchema: {},
        },
        {
          kind: 'event',
          namespace: 'agent',
          subject: 'foo_bar',
          fullSubject: 'agent.foo_bar',
          local: false,
          channel: false,
          payloadSchema: {},
        },
      ],
    } satisfies MakaioProtocolManifest;

    expect(() => generateRustSubjectsSection(manifest)).toThrow('Rust subject identifier collision');
  });

  it('fails loudly when the manifest repeats the same subject in one namespace', () => {
    const manifest = {
      version: 2,
      subjects: [
        {
          kind: 'event',
          namespace: 'agent',
          subject: 'message',
          fullSubject: 'agent.message',
          local: false,
          channel: false,
          payloadSchema: {},
        },
        {
          kind: 'event',
          namespace: 'agent',
          subject: 'message',
          fullSubject: 'agent.message',
          local: false,
          channel: false,
          payloadSchema: {},
        },
      ],
    } satisfies MakaioProtocolManifest;

    expect(() => generateRustSubjectsSection(manifest)).toThrow('Duplicate protocol subject');
  });

  it('matches the committed generated subjects section', async () => {
    const manifest = exportProtocolManifest({ catalog: PublicProtocolNamespaces });
    const committedSubjects = await readFile(RUST_SUBJECTS_PATH, 'utf8');
    const normalizedCommitted = committedSubjects.replace(/\r\n/g, '\n');
    const normalizedGenerated = generateRustSubjectsSection(manifest).replace(/\r\n/g, '\n');

    expect(normalizedCommitted.startsWith(normalizedGenerated)).toBe(true);
  });

  it('generates typed Rust subject structs for known payload types', () => {
    const manifest = exportProtocolManifest({ catalog: PublicProtocolNamespaces });
    const source = generateRustSubjectsSection(manifest);

    expect(source).toContain('pub struct Message;');
    expect(source).toContain('impl EventSubject for Message {');
    expect(source).toContain('type Payload = super::AgentMessagePayload;');
    expect(source).toContain('pub struct Execute;');
    expect(source).toContain('impl RequestSubject for Execute {');
    expect(source).toContain('type Request = super::ToolExecuteRequest;');
    expect(source).toContain('type Response = super::ToolExecuteResponse;');
  });
});
