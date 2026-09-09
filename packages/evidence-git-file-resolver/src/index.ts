/** Git file evidence resolution over a caller-provided source reader. */

import type { IMakaioBus } from '@makaio/bus-core';
import {
  ArtifactSubjects,
  EvidenceValueSchema,
  normalizeRepoContext,
  RepoContextSchema,
  sameRepoContext,
  type ArtifactEvidenceResolveResponse,
  type EvidenceValue,
} from '@makaio/contracts';

/** Git-file evidence accepted by this resolver. */
export type GitFileEvidence = Extract<EvidenceValue, { source: { kind: 'git-file' } }>;

/** Source identity for one immutable Git file. */
export type GitFileEvidenceSource = GitFileEvidence['source'];

/** Complete UTF-8 text returned by a source adapter. */
export interface GitFileReadResult {
  readonly source: GitFileEvidenceSource;
  readonly content: string;
  readonly complete: true;
}

/** Request lifecycle metadata forwarded to source adapters. */
export interface GitFileReadContext {
  readonly signal?: AbortSignal;
  /** Absolute Unix timestamp in milliseconds when the read should expire. */
  readonly deadline?: number;
}

/** Narrow source adapter implemented by a host or provider package. */
export interface GitFileReader {
  /** Read the complete UTF-8 file at the requested immutable source. */
  readFile(source: GitFileEvidenceSource, context: GitFileReadContext): Promise<GitFileReadResult>;
}

/** One provider-scoped Git-file resolver registration. */
export interface GitFileEvidenceResolverOptions {
  /** Repository provider kind exclusively owned by this handler. */
  readonly repositoryKind: string;
  readonly reader: GitFileReader;
}

/**
 * Compare requested and reported immutable source identities.
 * @param requested - Source requested from the reader.
 * @param actual - Source reported by the reader.
 * @returns Whether both sources identify the same immutable file.
 */
function sameSource(requested: GitFileEvidenceSource, actual: GitFileEvidenceSource): boolean {
  return (
    actual.kind === 'git-file' &&
    sameRepoContext(requested.repository, actual.repository) &&
    requested.path === actual.path &&
    requested.commit.toLowerCase() === actual.commit.toLowerCase()
  );
}

/**
 * Extract a complete one-based line range while preserving line endings.
 * @param content - Complete source text.
 * @param startLine - First requested one-based line.
 * @param lineCount - Number of requested lines.
 * @returns Exact text covered by the requested lines.
 */
function sliceLines(content: string, startLine: number, lineCount: number): string {
  let currentLine = 1;
  let selectionStart = startLine === 1 ? 0 : -1;
  const requestedEndLine = startLine + lineCount - 1;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character !== '\r' && character !== '\n') continue;

    const separatorEnd = character === '\r' && content[index + 1] === '\n' ? index + 2 : index + 1;
    if (currentLine === startLine - 1) selectionStart = separatorEnd;
    if (currentLine === requestedEndLine && selectionStart >= 0) {
      return content.slice(selectionStart, separatorEnd);
    }
    currentLine += 1;
    index = separatorEnd - 1;
  }

  const finalCharacter = content.at(-1);
  const hasUnterminatedFinalLine = finalCharacter !== undefined && finalCharacter !== '\r' && finalCharacter !== '\n';
  if (selectionStart >= 0 && hasUnterminatedFinalLine && currentLine === requestedEndLine) {
    return content.slice(selectionStart);
  }
  throw new Error(`Git file does not contain the complete requested line range ${startLine}-${requestedEndLine}`);
}

/**
 * Resolve a Git-file evidence value against its exact pinned source.
 * @param evidence - Git-file evidence pointer to resolve.
 * @param reader - Source adapter that reads immutable Git files.
 * @param context - Optional request lifecycle metadata forwarded to the reader.
 * @returns Fully resolved text and actual source identity.
 */
export async function resolveGitFileEvidence(
  evidence: GitFileEvidence,
  reader: GitFileReader,
  context: GitFileReadContext = {},
): Promise<ArtifactEvidenceResolveResponse> {
  const parsedEvidence = EvidenceValueSchema.parse(evidence);
  if (!isGitFileEvidence(parsedEvidence)) throw new Error('Expected Git-file evidence');

  const read = await reader.readFile(parsedEvidence.source, context);
  if (read.complete !== true) throw new Error('Git file reader returned incomplete content');
  if (typeof read.content !== 'string') throw new Error('Git file reader did not return text content');
  const parsedReadSource = EvidenceValueSchema.parse({
    source: read.source,
    location: { kind: 'whole-source' },
  }).source;
  if (parsedReadSource.kind !== 'git-file' || !sameSource(parsedEvidence.source, parsedReadSource)) {
    throw new Error('Git file reader returned content from a different source');
  }

  const text =
    parsedEvidence.location.kind === 'whole-source'
      ? read.content
      : sliceLines(read.content, parsedEvidence.location.startLine, parsedEvidence.location.lineCount);

  return {
    source: { ...parsedReadSource, repository: normalizeRepoContext(parsedReadSource.repository) },
    location: parsedEvidence.location,
    content: { kind: 'text', text },
  };
}

/**
 * Determine whether an evidence value is owned by this resolver.
 * @param evidence - Evidence value to inspect.
 * @returns Whether the evidence points to a Git file.
 */
function isGitFileEvidence(evidence: EvidenceValue): evidence is GitFileEvidence {
  return evidence.source.kind === 'git-file';
}

/**
 * Register the Git-file resolver on the shared evidence RPC subject.
 * The repository-kind filter gives each provider adapter exclusive ownership
 * without introducing a resolver registry or catch-all handler.
 * @param bus - Bus on which to register the filtered handler.
 * @param options - Provider identity and source adapter for this registration.
 * @returns Cleanup function that unregisters the resolver.
 */
export function registerGitFileEvidenceResolver(bus: IMakaioBus, options: GitFileEvidenceResolverOptions): () => void {
  const repositoryKind = RepoContextSchema.shape.kind.parse(options.repositoryKind);
  const filteredBus = bus.withFilter({
    'evidence.source.kind': 'git-file',
  });
  return filteredBus.on(ArtifactSubjects.evidence.resolve, async (context) => {
    // Bus filters compare the raw payload, while RepoContextSchema canonicalizes
    // surrounding whitespace. Provider ownership must therefore be decided only
    // after parsing, leaving other providers available to the dispatch chain.
    const evidence = EvidenceValueSchema.parse(context.payload.evidence);
    if (!isGitFileEvidence(evidence) || evidence.source.repository.kind !== repositoryKind) return;
    context.setResult(
      await resolveGitFileEvidence(evidence, options.reader, {
        signal: context.signal,
        deadline: context.deadline,
      }),
    );
  });
}
