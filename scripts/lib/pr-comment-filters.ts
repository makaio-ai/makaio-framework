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
 * Remove CodeRabbit's generated caution preamble without dropping human
 * caution callouts that happen to use the same markdown marker.
 * @param body - Review body after HTML/suggestion cleanup
 * @returns Body with only known bot caution preambles removed
 */
function stripKnownBotCautionBlocks(body: string): string {
  return body.replace(/(^|\n)\[!CAUTION\][\s\S]*?(?=\n<details>|$)/g, (block, prefix: string) => {
    if (/CodeRabbit|automated review|AI-generated/i.test(block)) {
      return prefix;
    }
    return block;
  });
}

/**
 * Strip common bot markup and low-signal wrapper text from a review body.
 * @param body - Raw comment or review body
 * @returns Cleaned body with trailing whitespace trimmed
 */
function stripBotNoise(body: string): string {
  return stripKnownBotCautionBlocks(stripHtmlCommentsAndSuggestionBlocks(body))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Determine whether a review body still contains actionable content.
 * @param body - Normalized review body
 * @returns True when the body looks like real feedback instead of walkthrough noise
 */
export function isActionableReviewBody(body: string): boolean {
  if (body.length === 0) {
    return false;
  }

  const lowSignalPatterns = [
    /^\[📝 Walkthrough\]/im,
    /^## Summary by CodeRabbit/im,
    /^## Walkthrough/im,
    /^### Changes traversed/im,
    /^### Sequence Diagram/im,
  ];

  if (
    lowSignalPatterns.some((pattern) => pattern.test(body)) &&
    !/Potential issue|Nitpick comments|Outside diff/i.test(body)
  ) {
    return false;
  }

  return true;
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
  if (/^@coderabbitai\s+review\s*$/im.test(body) || /^\[✅ Actions performed\]/im.test(body)) {
    return false;
  }
  if (/^\[📝 Walkthrough\]/im.test(body) || /^## Walkthrough/im.test(body)) {
    return /Potential issue|Nitpick|Outside diff/i.test(body);
  }
  return true;
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
    .replace(/\n*\[🪄 Autofix \(Beta\)\][\s\S]*?(?=\n---\n\n\[ℹ️ Review info\]|$)/g, '')
    .replace(/\n---\n\n\[ℹ️ Review info\][\s\S]*$/g, '')
    .replace(/\n*✅ Addressed in commit [\w\s.-]+$/im, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
