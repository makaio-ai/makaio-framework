import { createBusContext, createBusInstance, NoHandlerError } from '@makaio/bus-core';
import { ArtifactNamespace, ArtifactSubjects, type EvidenceValue } from '@makaio/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  registerGitFileEvidenceResolver,
  resolveGitFileEvidence,
  type GitFileEvidence,
  type GitFileReadContext,
  type GitFileReadResult,
  type GitFileReader,
} from './index.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const SOURCE = {
  kind: 'git-file' as const,
  repository: { kind: 'github-cloud', path: 'Makaio-AI/Makaio' },
  path: 'src/index.ts',
  commit: COMMIT,
};

function evidence(location: GitFileEvidence['location'] = { kind: 'whole-source' }): GitFileEvidence {
  return { source: SOURCE, location };
}

function reader(content: string, source = SOURCE): GitFileReader {
  return {
    readFile: vi.fn(async (): Promise<GitFileReadResult> => ({ source, content, complete: true })),
  };
}

describe('Git file evidence resolver', () => {
  it('returns the complete source text and its normalized actual identity', async () => {
    const result = await resolveGitFileEvidence(evidence(), reader('one\r\ntwo\n'));
    expect(result).toEqual({
      source: { ...SOURCE, repository: { kind: 'github-cloud', path: 'makaio-ai/makaio' } },
      location: { kind: 'whole-source' },
      content: { kind: 'text', text: 'one\r\ntwo\n' },
    });
  });

  it('forwards explicit read context and defaults direct calls to an empty context', async () => {
    const contexts: GitFileReadContext[] = [];
    const sourceReader: GitFileReader = {
      readFile: async (_source, context) => {
        contexts.push(context);
        return { source: SOURCE, content: 'resolved', complete: true };
      },
    };
    const controller = new AbortController();
    const context = { signal: controller.signal, deadline: 1_900_000_000_000 };

    await resolveGitFileEvidence(evidence(), sourceReader, context);
    await resolveGitFileEvidence(evidence(), sourceReader);

    expect(contexts).toEqual([context, {}]);
    expect(contexts[0]?.signal).toBe(controller.signal);
  });

  it('preserves original line endings and a final line without a terminator', async () => {
    await expect(
      resolveGitFileEvidence(evidence({ kind: 'lines', startLine: 2, lineCount: 2 }), reader('one\r\ntwo\r\nthree')),
    ).resolves.toMatchObject({ content: { kind: 'text', text: 'two\r\nthree' } });
    await expect(
      resolveGitFileEvidence(evidence({ kind: 'lines', startLine: 2, lineCount: 2 }), reader('one\rtwo\nthree\r')),
    ).resolves.toMatchObject({ content: { kind: 'text', text: 'two\nthree\r' } });
  });

  it('rejects a line range that is not completely available', async () => {
    await expect(
      resolveGitFileEvidence(evidence({ kind: 'lines', startLine: 2, lineCount: 2 }), reader('one\ntwo\n')),
    ).rejects.toThrow('complete requested line range');
    await expect(
      resolveGitFileEvidence(evidence({ kind: 'lines', startLine: 3, lineCount: 1 }), reader('one\ntwo\n')),
    ).rejects.toThrow('complete requested line range');
  });

  it('validates standalone resolver input before reading a source', async () => {
    const invalid = evidence({ kind: 'lines', startLine: 1, lineCount: 1 });
    Reflect.set(invalid.location, 'lineCount', 0);
    const sourceReader = reader('unused');
    await expect(resolveGitFileEvidence(invalid, sourceReader)).rejects.toThrow();
    expect(sourceReader.readFile).not.toHaveBeenCalled();
  });

  it('rejects incomplete content and any actual source mismatch', async () => {
    const incomplete: GitFileReadResult = { source: SOURCE, content: 'partial', complete: true };
    Reflect.set(incomplete, 'complete', false);
    await expect(resolveGitFileEvidence(evidence(), { readFile: async () => incomplete })).rejects.toThrow(
      'incomplete content',
    );
    await expect(
      resolveGitFileEvidence(evidence(), reader('wrong', { ...SOURCE, commit: 'a'.repeat(40) })),
    ).rejects.toThrow('different source');
  });

  it('routes by evidence and repository kind, forwards request context, and unregisters cleanly', async () => {
    const bus = createBusInstance({ context: createBusContext() });
    bus.registerNamespace(ArtifactNamespace);
    const githubContexts: GitFileReadContext[] = [];
    const githubRead = vi.fn(async (_source: GitFileEvidence['source'], context: GitFileReadContext) => {
      githubContexts.push(context);
      return { source: SOURCE, content: 'resolved', complete: true } satisfies GitFileReadResult;
    });
    const gitlabSource = { ...SOURCE, repository: { kind: 'gitlab', path: 'Makaio-AI/Makaio' } };
    const gitlabRead = vi.fn(async () => {
      return { source: gitlabSource, content: 'gitlab', complete: true } satisfies GitFileReadResult;
    });
    const unregisterGithub = registerGitFileEvidenceResolver(bus, {
      repositoryKind: 'github-cloud',
      reader: { readFile: githubRead },
    });
    const unregisterGitlab = registerGitFileEvidenceResolver(bus, {
      repositoryKind: 'gitlab',
      reader: { readFile: gitlabRead },
    });
    const controller = new AbortController();
    const requestStartedAt = Date.now();
    const paddedGithubEvidence = {
      ...evidence(),
      source: {
        ...SOURCE,
        repository: { ...SOURCE.repository, kind: ' github-cloud ' },
      },
    };

    await expect(
      bus.request(
        ArtifactSubjects.evidence.resolve,
        { evidence: paddedGithubEvidence },
        { signal: controller.signal, timeout: 5_000 },
      ),
    ).resolves.toMatchObject({ content: { kind: 'text', text: 'resolved' } });
    expect(githubRead).toHaveBeenCalledTimes(1);
    expect(gitlabRead).not.toHaveBeenCalled();
    expect(githubContexts[0]?.signal).toBe(controller.signal);
    expect(githubContexts[0]?.deadline).toBeGreaterThanOrEqual(requestStartedAt + 5_000);
    expect(githubContexts[0]?.deadline).toBeLessThanOrEqual(Date.now() + 5_000);

    await expect(
      bus.request(ArtifactSubjects.evidence.resolve, { evidence: { ...evidence(), source: gitlabSource } }),
    ).resolves.toMatchObject({ content: { kind: 'text', text: 'gitlab' } });
    expect(gitlabRead).toHaveBeenCalledTimes(1);
    expect(githubRead).toHaveBeenCalledTimes(1);

    const confluenceEvidence: EvidenceValue = {
      source: { kind: 'confluence-page', site: 'example.atlassian.net', pageId: '1', version: 1 },
      location: { kind: 'whole-source' },
    };
    await expect(
      bus.request(ArtifactSubjects.evidence.resolve, { evidence: confluenceEvidence }),
    ).rejects.toBeInstanceOf(NoHandlerError);
    expect(githubRead).toHaveBeenCalledTimes(1);
    expect(gitlabRead).toHaveBeenCalledTimes(1);

    unregisterGithub();
    unregisterGitlab();
    await expect(bus.request(ArtifactSubjects.evidence.resolve, { evidence: evidence() })).rejects.toBeInstanceOf(
      NoHandlerError,
    );
  });

  it('propagates source adapter failures', async () => {
    const sourceReader: GitFileReader = {
      readFile: vi.fn(async () => {
        throw new Error('commit unavailable');
      }),
    };
    await expect(resolveGitFileEvidence(evidence(), sourceReader)).rejects.toThrow('commit unavailable');
  });
});
