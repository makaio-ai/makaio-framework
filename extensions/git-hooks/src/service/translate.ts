/**
 * Normalizes raw inbound hook payloads into typed git hook events.
 *
 * The translator is the single place where `eventName`, `argv`, and
 * `stdinText` are interpreted. Downstream service code only works with
 * `NormalizedGitHookEvent` and never touches the raw payload fields.
 * @packageDocumentation
 */

import type { RawInboundHookPayload } from '@makaio/inbound-hooks';

/**
 * Typed union of git hook events produced by the translator.
 *
 * Each variant carries exactly the fields the service needs to emit either a
 * canonical `git.*` event or native `gitHook.*` metadata.
 */
export type NormalizedGitHookEvent =
  | { readonly kind: 'commit'; readonly repoPath: string }
  | {
      readonly kind: 'checkout';
      readonly repoPath: string;
      readonly previousHead: string;
      readonly currentHead: string;
    }
  | {
      readonly kind: 'merge';
      readonly repoPath: string;
      readonly squash: boolean;
    }
  | {
      readonly kind: 'rewrite';
      readonly repoPath: string;
      readonly command: string;
      readonly rewritten: readonly { readonly oldHash: string; readonly newHash: string }[];
    };

/**
 * Normalize a raw inbound hook payload into a typed git hook event.
 *
 * Returns `null` when the payload is not a recognized git hook event
 * (unknown `eventName`, missing `repoPath`, or a file checkout).
 * @param payload - Raw inbound hook payload from the git hook receiver.
 * @returns Normalized event, or `null` when the payload is not a recognized git event.
 */
export function normalizeGitHookEvent(payload: RawInboundHookPayload): NormalizedGitHookEvent | null {
  const repoPath = typeof payload.payload.repoPath === 'string' ? payload.payload.repoPath : undefined;
  if (!repoPath) {
    return null;
  }

  if (payload.eventName === 'post-commit') {
    return { kind: 'commit', repoPath };
  }

  if (payload.eventName === 'post-checkout') {
    const [previousHead, currentHead, branchFlag] = payload.argv;
    if (previousHead && currentHead && branchFlag === '1') {
      return { kind: 'checkout', repoPath, previousHead, currentHead };
    }
    return null;
  }

  if (payload.eventName === 'post-merge') {
    const [squashFlag] = payload.argv;
    if (squashFlag === '0' || squashFlag === '1') {
      return { kind: 'merge', repoPath, squash: squashFlag === '1' };
    }
    return null;
  }

  if (payload.eventName === 'post-rewrite') {
    const [command] = payload.argv;
    if (!command) {
      return null;
    }
    return {
      kind: 'rewrite',
      repoPath,
      command,
      rewritten: parseRewritePairs(payload.stdinText),
    };
  }

  return null;
}

/**
 * Parse the stdin text from a `post-rewrite` hook invocation into
 * old/new hash pairs.
 *
 * Each line of stdin contains `<old-hash> <new-hash> [extra]`. Lines
 * with fewer than two whitespace-separated tokens are skipped.
 * @param stdinText - Raw stdin text from the hook invocation.
 * @returns Array of old/new hash pairs.
 */
function parseRewritePairs(stdinText: string): readonly { readonly oldHash: string; readonly newHash: string }[] {
  return stdinText
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (parts): parts is [string, string, ...string[]] =>
        parts.length >= 2 && parts[0]!.length > 0 && parts[1]!.length > 0,
    )
    .map(([oldHash, newHash]) => ({ oldHash, newHash }));
}
