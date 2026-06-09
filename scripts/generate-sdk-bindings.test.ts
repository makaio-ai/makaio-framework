import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import type { MakaioProtocolManifest, MakaioProtocolRequestSubject } from '../core/contracts/src/protocol/types.js';
import { findGeneratedFileDrift, generateSdkFiles, parseSdkCodegenArgs } from './generate-sdk-bindings.js';
import {
  PYTHON_GENERATED_DIR,
  PYTHON_SUBJECTS_PATH,
  RUST_SUBJECTS_PATH,
  SDK_PROTOCOL_MANIFEST_PATH,
} from './lib/sdk-generation-paths.js';

const STRUCTURED_OUTPUT_PROTOCOL_SUBJECTS = [
  {
    subject: 'structuredOutput.enforce',
    fullSubject: 'agent.structuredOutput.enforce',
    pythonConstant: 'AGENT_STRUCTURED_OUTPUT_ENFORCE',
    pythonVariable: 'structured_output_enforce',
    pythonRequestType: 'AgentStructuredOutputEnforceRequest',
    pythonResponseType: 'AgentStructuredOutputEnforceResponse',
    rustConstant: 'STRUCTURED_OUTPUT_ENFORCE',
    rustType: 'StructuredOutputEnforce',
  },
  {
    subject: 'structuredOutput.retryPolicy',
    fullSubject: 'agent.structuredOutput.retryPolicy',
    pythonConstant: 'AGENT_STRUCTURED_OUTPUT_RETRY_POLICY',
    pythonVariable: 'structured_output_retry_policy',
    pythonRequestType: 'AgentStructuredOutputRetryPolicyRequest',
    pythonResponseType: 'AgentStructuredOutputRetryPolicyResponse',
    rustConstant: 'STRUCTURED_OUTPUT_RETRY_POLICY',
    rustType: 'StructuredOutputRetryPolicy',
  },
] as const;

/**
 * Find generated file content by absolute output path.
 * @param files - In-memory generated SDK files.
 * @param filePath - Absolute path of the generated file to read.
 * @returns Generated file content.
 */
function requireGeneratedFile(files: Awaited<ReturnType<typeof generateSdkFiles>>, filePath: string): string {
  const file = files.find((entry) => entry.path === filePath);
  if (file === undefined) {
    throw new Error(`Expected generated file ${filePath}`);
  }
  return file.content;
}

/**
 * Parse the generated protocol manifest from the in-memory codegen output.
 * @param files - In-memory generated SDK files.
 * @returns Parsed protocol manifest.
 */
function requireGeneratedManifest(files: Awaited<ReturnType<typeof generateSdkFiles>>): MakaioProtocolManifest {
  return JSON.parse(requireGeneratedFile(files, SDK_PROTOCOL_MANIFEST_PATH)) as MakaioProtocolManifest;
}

/**
 * Find a request subject in the generated protocol manifest.
 * @param manifest - Parsed protocol manifest.
 * @param fullSubject - Fully qualified protocol subject.
 * @returns Matching request subject entry.
 */
function requireRequestSubject(manifest: MakaioProtocolManifest, fullSubject: string): MakaioProtocolRequestSubject {
  const subject = manifest.subjects.find((entry) => entry.fullSubject === fullSubject);
  if (subject === undefined) {
    throw new Error(`Expected protocol subject ${fullSubject}`);
  }
  if (subject.kind !== 'request') {
    throw new Error(`Expected protocol subject ${fullSubject} to be a request`);
  }
  return subject;
}

describe('parseSdkCodegenArgs', () => {
  it('enables check mode with --check', () => {
    expect(parseSdkCodegenArgs(['--check'])).toEqual({ check: true });
  });

  it('uses write mode by default', () => {
    expect(parseSdkCodegenArgs([])).toEqual({ check: false });
  });
});

describe('findGeneratedFileDrift', () => {
  it('reports generated files whose committed content differs', async () => {
    const drift = await findGeneratedFileDrift(
      [
        { path: '/repo/sdks/manifest/makaio-bus-protocol.json', content: '{ "version": 2 }\n' },
        { path: '/repo/sdks/python/src/makaio/generated/subjects.py', content: 'EXPECTED\n' },
      ],
      async (filePath) => (filePath.endsWith('subjects.py') ? 'STALE\n' : '{ "version": 2 }\n'),
    );

    expect(drift).toEqual(['/repo/sdks/python/src/makaio/generated/subjects.py']);
  });
});

describe('generateSdkFiles structured-output protocol coverage', () => {
  it('publishes structured-output request subjects to the protocol manifest and generated SDK catalogs', async () => {
    const files = await generateSdkFiles();
    const manifest = requireGeneratedManifest(files);
    const pythonSubjects = requireGeneratedFile(files, PYTHON_SUBJECTS_PATH);
    const pythonAgentNamespace = requireGeneratedFile(files, resolve(PYTHON_GENERATED_DIR, 'agent.py'));
    const rustSubjects = requireGeneratedFile(files, RUST_SUBJECTS_PATH);

    for (const expected of STRUCTURED_OUTPUT_PROTOCOL_SUBJECTS) {
      expect(requireRequestSubject(manifest, expected.fullSubject)).toMatchObject({
        kind: 'request',
        namespace: 'agent',
        subject: expected.subject,
        fullSubject: expected.fullSubject,
        local: false,
        channel: false,
      });

      expect(pythonSubjects).toContain(`${expected.pythonConstant} = "${expected.fullSubject}"`);
      expect(pythonSubjects).toContain(`    ${expected.pythonConstant},`);
      expect(pythonAgentNamespace).toContain(
        `${expected.pythonVariable}: RequestSubject[${expected.pythonRequestType}, ${expected.pythonResponseType}] = RequestSubject("${expected.fullSubject}", request_type=${expected.pythonRequestType}, response_type=${expected.pythonResponseType})`,
      );

      expect(rustSubjects).toContain(`pub const ${expected.rustConstant}: &str = "${expected.fullSubject}";`);
      expect(rustSubjects).toContain(`pub struct ${expected.rustType};`);
      expect(rustSubjects).toContain(`impl RequestSubject for ${expected.rustType} {`);
      expect(rustSubjects).toContain(`subject: "${expected.subject}",`);
      expect(rustSubjects).toContain(`full_subject: agent::${expected.rustConstant},`);
    }
  });

  it('preserves enforce request diagnostics and discriminated response shape in the protocol manifest', async () => {
    const files = await generateSdkFiles();
    const manifest = requireGeneratedManifest(files);
    const pythonAgentPayloads = requireGeneratedFile(files, resolve(PYTHON_GENERATED_DIR, 'payloads', 'agent.py'));
    const subject = requireRequestSubject(manifest, 'agent.structuredOutput.enforce');

    expect(subject.requestSchema).toMatchObject({
      properties: {
        validationErrors: {
          minItems: 1,
        },
      },
    });
    expect(subject.responseSchema).toEqual({
      oneOf: [
        {
          additionalProperties: false,
          properties: {
            enforced: {
              const: true,
              type: 'boolean',
            },
            output: {
              type: 'string',
            },
          },
          required: ['enforced', 'output'],
          type: 'object',
        },
        {
          additionalProperties: false,
          properties: {
            enforced: {
              const: false,
              type: 'boolean',
            },
            error: {
              type: 'string',
            },
          },
          required: ['enforced', 'error'],
          type: 'object',
        },
      ],
    });
    expect(pythonAgentPayloads).toContain('class AgentStructuredOutputEnforceResponseVariantA:');
    expect(pythonAgentPayloads).toContain('    enforced: Literal[True]');
    expect(pythonAgentPayloads).toContain('    output: str');
    expect(pythonAgentPayloads).toContain('class AgentStructuredOutputEnforceResponseVariantB:');
    expect(pythonAgentPayloads).toContain('    enforced: Literal[False]');
    expect(pythonAgentPayloads).toContain('    error: str');
    expect(pythonAgentPayloads).toContain(
      'AgentStructuredOutputEnforceResponse = Union[AgentStructuredOutputEnforceResponseVariantA, AgentStructuredOutputEnforceResponseVariantB]',
    );
  });
});
