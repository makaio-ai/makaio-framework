/**
 * Pure filtering and normalization functions for PR review entry bodies.
 */

const HTML_COMMENT_OPEN = '<!--';
const HTML_COMMENT_CLOSE = '-->';
const SUGGESTION_START_MARKER = 'suggestion_start';
const SUGGESTION_END_MARKER = 'suggestion_end';

/**
 * Remove HTML comment nodes and CodeRabbit suggestion blocks from review text.
 *
 * This is intentionally a delimiter scanner instead of a replacement regex:
 * the output is terminal text, but review comments can contain arbitrary
 * markdown/HTML fragments and incomplete comment delimiters should not leak
 * half-normalized bot markup into the actionable finding output.
 * @param body - Raw review body
 * @returns Body without HTML comments or suggestion block content
 */
function stripHtmlCommentsAndSuggestionBlocks(body: string): string {
  let output = '';
  let cursor = 0;
  let insideSuggestionBlock = false;

  while (cursor < body.length) {
    const commentStart = body.indexOf(HTML_COMMENT_OPEN, cursor);
    if (commentStart === -1) {
      if (!insideSuggestionBlock) {
        output += body.slice(cursor);
      }
      break;
    }

    if (!insideSuggestionBlock) {
      output += body.slice(cursor, commentStart);
    }

    const commentEnd = body.indexOf(HTML_COMMENT_CLOSE, commentStart + HTML_COMMENT_OPEN.length);
    if (commentEnd === -1) {
      break;
    }

    const marker = body.slice(commentStart + HTML_COMMENT_OPEN.length, commentEnd).trim();
    if (marker === SUGGESTION_START_MARKER) {
      insideSuggestionBlock = true;
    } else if (marker === SUGGESTION_END_MARKER) {
      insideSuggestionBlock = false;
    }

    cursor = commentEnd + HTML_COMMENT_CLOSE.length;
  }

  return output;
}

/**
 * Strip common bot markup and low-signal wrapper text from a review body.
 * @param body - Raw comment or review body
 * @returns Cleaned body with trailing whitespace trimmed
 */
function stripBotNoise(body: string): string {
  return stripHtmlCommentsAndSuggestionBlocks(body)
    .replace(/\[!CAUTION\][\s\S]*?(?=<details>|$)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Determine whether a review body still contains actionable content.
 * @param body - Raw review body (before normalization)
 * @returns True when the body looks like a real finding instead of walkthrough noise
 */
export function isActionableReviewBody(body: string): boolean {
  if (body.length === 0) {
    return false;
  }

  const lowSignalPatterns = [
    /^## Summary by CodeRabbit/im,
    /^## Walkthrough/im,
    /^### Changes traversed/im,
    /^### Sequence Diagram/im,
  ];

  const actionableReviewPattern =
    /Potential issue|Nitpick comments|Outside diff|Prompt for AI Agents|Codex Review|\bP\d+\s+Badge\b|`[^`]+` \(\d+\)|`\d+-\d+`/i;

  if (lowSignalPatterns.some((pattern) => pattern.test(body)) && !actionableReviewPattern.test(body)) {
    return false;
  }

  return actionableReviewPattern.test(body);
}

/**
 * Determine whether a file comment is actionable after cleanup.
 * @param body - Cleaned comment body
 * @returns True when the comment still has useful content
 */
export function isActionableFileComment(body: string): boolean {
  if (body.length === 0) {
    return false;
  }
  return !/^✅ Addressed in commit\b/im.test(body);
}

/**
 * Determine whether an issue comment is actionable after cleanup.
 *
 * Issue comments include CodeRabbit "Prompt for AI Agents" posts and
 * human discussion that may contain actionable feedback.
 * @param body - Cleaned comment body
 * @returns True when the comment looks like real feedback
 */
export function isActionableIssueComment(body: string): boolean {
  if (body.length === 0) {
    return false;
  }
  if (/^✅ Addressed in commit\b/im.test(body)) {
    return false;
  }
  // Actionable: contains file references, line numbers, or known review markers.
  return /`[^`]+\.(ts|tsx|js|jsx|sql|json)`|line \d+|Potential issue|Nitpick|Prompt for AI Agents|Codex Review|\bP\d+\s+Badge\b/i.test(
    body,
  );
}

/**
 * Remove resolved boilerplate and stale-addressed markers from a review entry body.
 * @param body - Original review text
 * @returns Cleaned text
 */
export function normalizeReviewBody(body: string): string {
  return stripBotNoise(body)
    .replace(/^>\s?/gm, '')
    .replace(
      /<details>\s*<summary>(Fix|♻️[^<]*|🛡️ Proposed fix[^<]*|🤖 Prompt for AI Agents|🧰 Tools|📝 Committable suggestion)[\s\S]*?<\/details>/g,
      '',
    )
    .replace(/As per coding guidelines[^\n]*\n?/g, '')
    .replace(/<\/?blockquote>/g, '')
    .replace(/<\/?details>/g, '')
    .replace(/<summary>([^<]+)<\/summary>/g, '[$1]')
    .replace(
      /\[(Fix|♻️ [^\]]+|🛡️ Proposed fix[^\]]*|🤖 Prompt[^\]]+|🧰 Tools|📝 Committable suggestion)\]\s*```[\s\S]*?```/g,
      '',
    )
    .replace(/\[(Fix|♻️ [^\]]+|🛡️ Proposed fix[^\]]*|🤖 Prompt[^\]]+|🧰 Tools|📝 Committable suggestion)\]\n?/g, '')
    .replace(/\n---\n\n\[ℹ️ Review info\][\s\S]*$/g, '')
    .replace(/\n*✅ Addressed in commit [\w\s.-]+$/im, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
