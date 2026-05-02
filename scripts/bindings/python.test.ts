import { readFile } from 'node:fs/promises';
import '@makaio/contracts';
import { describe, expect, it } from 'vitest';
import { PublicProtocolNamespaces } from '../../packages/contracts/src/protocol/catalog.js';
import type { MakaioProtocolManifest } from '../../packages/contracts/src/protocol/types.js';
import { exportProtocolManifest } from '../../packages/contracts/src/protocol/index.js';
import { PYTHON_SUBJECTS_PATH } from '../lib/sdk-generation-paths.js';
import { generatePythonSubjects, toPythonConstantName } from './python.js';

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
      version: 1,
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
