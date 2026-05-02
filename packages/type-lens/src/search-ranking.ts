import type { SymbolKind } from './schemas.js';

export type SearchMatchKind = 'exact' | 'prefix' | 'fts' | 'semantic';

/** Public ranked search match returned by {@link finalizeSearchCandidates}. */
export interface SearchSymbolMatch {
  /** Stable symbol ID. */
  symbolId: string;
  /** Alias hash for continuity. */
  aliasHash: string;
  /** Symbol name. */
  name: string;
  /** Symbol kind (class, function, etc.). */
  kind: SymbolKind;
  /** Absolute file path. */
  file: string;
  /** 1-based source line number. */
  line: number;
  /** Optional symbol signature text. */
  signature?: string;
  /** Branch the symbol was indexed from. */
  branch: string;
  /** Ranking metadata. */
  ranking: {
    /** How the match was found. */
    matchKind: SearchMatchKind;
    /** Internal relevance score (higher is better). */
    score: number;
    /** 1-based rank within the result set. */
    rank: number;
  };
}

/**
 * Internal search candidate before final rank numbers are assigned.
 */
export interface SearchSymbolCandidate {
  symbolId: string;
  aliasHash: string;
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  signature?: string;
  branch: string;
  ranking: {
    score: number;
    matchKind: SearchMatchKind;
  };
}

/**
 * Minimal lexical symbol record shape needed by rankLexicalCandidate.
 */
export interface SearchLexicalRecord {
  symbol: {
    id: string;
    name: string;
    kind: SymbolKind;
    line: number;
    signature?: string;
  };
  aliasHash: string;
  absoluteFilePath: string;
  relativeFilePath: string;
  nameLower: string;
  signatureLower: string;
}

/**
 * Rank a symbol record against a normalized query using lexical heuristics.
 * @param record - Candidate symbol record.
 * @param query - Normalized lowercase query text.
 * @param branch - Branch name for result metadata.
 * @returns Ranked candidate or null when there is no lexical match.
 */
export function rankLexicalCandidate(
  record: SearchLexicalRecord,
  query: string,
  branch: string,
): SearchSymbolCandidate | null {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return null;

  let matchKind: SearchMatchKind | null = null;
  let score = 0;

  if (record.nameLower === normalizedQuery) {
    matchKind = 'exact';
    score = 4000;
  } else if (record.nameLower.startsWith(normalizedQuery)) {
    matchKind = 'prefix';
    score = 3000 - Math.min(record.symbol.name.length, 100);
  } else if (
    record.nameLower.includes(normalizedQuery) ||
    record.signatureLower.includes(normalizedQuery) ||
    record.relativeFilePath.toLowerCase().includes(normalizedQuery)
  ) {
    matchKind = 'fts';
    score = 2000;
  }

  if (!matchKind) return null;
  return {
    symbolId: record.symbol.id,
    aliasHash: record.aliasHash,
    name: record.symbol.name,
    kind: record.symbol.kind,
    file: record.absoluteFilePath,
    line: record.symbol.line,
    signature: record.symbol.signature,
    branch,
    ranking: {
      matchKind,
      score,
    },
  };
}

/**
 * Sort candidates by match kind priority, then score and stable tiebreakers.
 * @param matches - Candidate array to sort in place.
 */
export function sortSearchCandidates(matches: SearchSymbolCandidate[]): void {
  const priority = (kind: SearchMatchKind): number => {
    if (kind === 'exact') return 4;
    if (kind === 'prefix') return 3;
    if (kind === 'fts') return 2;
    if (kind === 'semantic') return 1;
    return 0;
  };

  matches.sort((left, right) => {
    const priorityDiff = priority(right.ranking.matchKind) - priority(left.ranking.matchKind);
    if (priorityDiff !== 0) return priorityDiff;
    const scoreDiff = right.ranking.score - left.ranking.score;
    if (scoreDiff !== 0) return scoreDiff;
    const nameDiff = left.name.localeCompare(right.name);
    if (nameDiff !== 0) return nameDiff;
    const fileDiff = left.file.localeCompare(right.file);
    if (fileDiff !== 0) return fileDiff;
    return left.line - right.line;
  });
}

/**
 * Convert internal candidates to API matches with public rank values.
 * @param matches - Sorted candidate list.
 * @param limit - Max results to return.
 * @returns Public SearchSymbolMatch payload.
 */
export function finalizeSearchCandidates(matches: SearchSymbolCandidate[], limit: number): SearchSymbolMatch[] {
  return matches.slice(0, limit).map((match, idx) => ({
    ...match,
    ranking: {
      ...match.ranking,
      rank: idx + 1,
    },
  }));
}
