import type {
  VCSReviewComment,
  FindingSeverity,
  IReviewerProcessor,
  ReviewFinding,
  ReviewSourceRateLimit,
  SuggestedChange,
  ProcessCommentsParams,
  ProcessReviewBodyParams,
} from '@makaio/contracts';

// ---------------------------------------------------------------------------
// Severity parsing
// ---------------------------------------------------------------------------

/**
 * Map CodeRabbit emoji severity markers to normalized {@link FindingSeverity} values.
 *
 * CodeRabbit uses emoji at the top of each comment to signal severity.
 * @param body - Raw comment body text
 * @returns Normalized severity level
 */
export function parseSeverity(body: string): FindingSeverity {
  if (body.includes('🔴') || body.includes('🚨')) return 'critical';
  if (body.includes('⚠️') || /Potential issue/i.test(body)) return 'major';
  if (body.includes('🟡') || /Minor/i.test(body)) return 'minor';
  if (body.includes('🧹') || /Nitpick/i.test(body)) return 'nitpick';
  // Default — unknown severity treated as minor
  return 'minor';
}

// ---------------------------------------------------------------------------
// HTML details-block extraction
// ---------------------------------------------------------------------------

/**
 * Extract the inner content of a `<details><summary>PATTERN</summary>…</details>` block.
 *
 * Matches the first block whose summary text contains the given pattern string.
 * The match is case-sensitive and literal (not a regex).
 * @param body - Raw HTML/Markdown string to search
 * @param summaryPattern - Literal substring to locate inside the `<summary>` tag
 * @returns Inner content of the matched `<details>` block, or `undefined` when not found
 */
export function extractDetailsBlock(body: string, summaryPattern: string): string | undefined {
  const escapedPattern = summaryPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match <details>…<summary>…PATTERN…</summary>…</details>  (non-greedy, dotAll)
  const re = new RegExp(
    `<details>[\\s\\S]*?<summary>[^<]*${escapedPattern}[^<]*<\\/summary>([\\s\\S]*?)<\\/details>`,
    'i',
  );
  const match = re.exec(body);
  return match ? match[1].trim() : undefined;
}

// ---------------------------------------------------------------------------
// Diff suggestion parsing
// ---------------------------------------------------------------------------

/**
 * Parse a fenced diff block into structured {@link SuggestedChange} objects.
 *
 * Expects standard unified-diff format: lines starting with `-` are the
 * old code, lines starting with `+` are the new code.
 * Context lines (no prefix) are ignored.
 * @param diffBlock - Content between the triple-backtick diff fences
 * @param filePath - File path the diff applies to
 * @returns Array of structured suggested changes (one per contiguous hunk)
 */
export function parseDiffSuggestions(diffBlock: string, filePath: string): SuggestedChange[] {
  const lines = diffBlock.split('\n');
  const removedLines: string[] = [];
  const addedLines: string[] = [];
  const suggestions: SuggestedChange[] = [];

  const flush = (): void => {
    if (removedLines.length === 0 && addedLines.length === 0) return;
    suggestions.push({
      file: filePath,
      oldCode: removedLines.join('\n'),
      newCode: addedLines.join('\n'),
    });
    removedLines.length = 0;
    addedLines.length = 0;
  };

  for (const line of lines) {
    if (line.startsWith('@@')) {
      flush();
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removedLines.push(line.slice(1));
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      addedLines.push(line.slice(1));
    }
  }

  flush();

  return suggestions;
}

// ---------------------------------------------------------------------------
// Metadata stripping
// ---------------------------------------------------------------------------

/**
 * Remove CodeRabbit-internal metadata from a comment body.
 *
 * Strips:
 * - HTML comments (`<!-- … -->`) used for fingerprinting and internal state
 * - Base64 blobs often appended as hidden state
 * @param body - Raw comment body from the VCS API
 * @returns Cleaned body suitable for display or further parsing
 */
export function stripCodeRabbitMetadata(body: string): string {
  let result = body;
  let start: number;
  while ((start = result.indexOf('<!--')) !== -1) {
    const end = result.indexOf('-->', start + 4);
    if (end === -1) break;
    result = result.slice(0, start) + result.slice(end + 3);
  }
  return result.trim();
}

// ---------------------------------------------------------------------------
// Comment-level parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract the human-readable summary line from a CodeRabbit comment.
 *
 * CodeRabbit formats its first content line as a bold Markdown sentence
 * immediately after the severity indicator line.
 * @param body - Cleaned comment body
 * @returns First bold sentence found, or an empty string
 */
export function extractSummaryLine(body: string): string {
  const match = /\*\*([^*]+)\*\*/.exec(body);
  return match ? match[1].trim() : '';
}

/**
 * Extract the explanation paragraph following the summary bold line.
 *
 * Takes the text between the summary bold line and the first `<details>` block.
 * @param body - Cleaned comment body
 * @returns Explanation text, or an empty string when absent
 */
export function extractExplanation(body: string): string {
  // Remove leading severity + summary bold line, then take text before first <details>
  const withoutSummary = body.replace(/\*\*[^*]+\*\*/, '').trim();
  const detailsIndex = withoutSummary.indexOf('<details>');
  const explanation = detailsIndex !== -1 ? withoutSummary.slice(0, detailsIndex) : withoutSummary;
  return explanation.trim();
}

/**
 * Build a `message` string by combining the summary line and explanation.
 * @param summary - Bold summary sentence
 * @param explanation - Following explanation paragraph
 * @returns Combined message string
 */
export function buildMessage(summary: string, explanation: string): string {
  if (!summary && !explanation) return '';
  if (!explanation) return summary;
  if (!summary) return explanation;
  return `${summary}\n\n${explanation}`;
}

/**
 * Extract all fenced diff blocks from a string and parse them.
 * @param text - Text that may contain fenced diff blocks
 * @param filePath - File the diffs apply to
 * @returns Parsed suggested changes from all diff blocks
 */
export function extractDiffSuggestions(text: string, filePath: string): SuggestedChange[] {
  const suggestions: SuggestedChange[] = [];
  const diffRe = /```diff\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = diffRe.exec(text)) !== null) {
    const parsed = parseDiffSuggestions(match[1], filePath);
    suggestions.push(...parsed);
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// Stable ID generation
// ---------------------------------------------------------------------------

/**
 * Compute a short content-based hash from a message and its suggested changes.
 *
 * Used to produce stable, deterministic finding IDs for review-body findings
 * that have no raw comment ID anchor (per AD-15).
 * @param message - Finding message text
 * @param suggestions - Structured suggested changes attached to the finding
 * @returns Short base-36 hash string
 */
export function contentHash(message: string, suggestions: SuggestedChange[]): string {
  const normalized = message.trim() + suggestions.map((s) => `${s.file}:${s.oldCode}:${s.newCode}`).join('|');
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

// ---------------------------------------------------------------------------
// Inline comment → ReviewFinding
// ---------------------------------------------------------------------------

/**
 * Convert a single inline VCS review comment from CodeRabbit into a {@link ReviewFinding}.
 *
 * Skips general PR comments (no path) and reply comments (inReplyToId is set),
 * as these are not actionable findings.
 * @param comment - Inline file-level comment from the VCS API
 * @param params - Processing parameters carrying sourceId and target
 * @returns Structured finding, or `null` for general/reply comments
 */
export function commentToFinding(comment: VCSReviewComment, params: ProcessCommentsParams): ReviewFinding | null {
  // General PR comments and reply comments are not actionable findings.
  if (!comment.path || comment.inReplyToId !== null) return null;

  const cleaned = stripCodeRabbitMetadata(comment.body);
  const severity = parseSeverity(cleaned);
  const summary = extractSummaryLine(cleaned);
  const explanation = extractExplanation(cleaned);
  const message = buildMessage(summary, explanation) || cleaned;

  // Parse structured diff suggestions from the 🔧 Suggested fix block
  const suggestionBlock = extractDetailsBlock(cleaned, '🔧 Suggested fix');
  const suggestedChanges = suggestionBlock ? extractDiffSuggestions(suggestionBlock, comment.path) : [];

  // Extract AI-optimized agent prompt
  const agentPromptBlock = extractDetailsBlock(cleaned, '🤖 Prompt for AI Agents');
  const agentPrompt = agentPromptBlock ? agentPromptBlock.replace(/<[^>]+>/g, '').trim() || null : null;

  // Stable ID: prefer raw comment id, fall back to path+line composite
  const id = comment.id
    ? `${params.sourceId}:inline:${comment.id}`
    : `${params.sourceId}:inline:${comment.threadId ?? ''}:${comment.path}:${comment.line ?? 0}`;

  const createdAt = Date.parse(comment.createdAt);
  const updatedAt = Date.parse(comment.updatedAt);

  const finding: ReviewFinding = {
    id,
    target: params.target,
    sourceId: params.sourceId,
    reviewer: 'coderabbit',
    origin: 'inline',
    threadId: comment.threadId ?? null,
    severity,
    file: comment.path,
    startLine: comment.line ?? null,
    endLine: comment.line ?? null,
    message,
    agentPrompt,
    suggestedChanges,
    status: comment.isResolved ? 'verified' : 'open',
    addressedBy: null,
    addressedAt: null,
    verifiedAt: null,
    dismissedReason: null,
    createdAt,
    updatedAt,
    rawCommentId: comment.id,
  };

  return finding;
}

// ---------------------------------------------------------------------------
// Rate limit parsing
// ---------------------------------------------------------------------------

/**
 * Parse CodeRabbit rate limit state from a raw body string.
 *
 * CodeRabbit embeds rate limit information inside HTML comments using the
 * marker `<!-- review_rate_limit_status_start -->`. The JSON payload is
 * expected to carry `remaining`, `limit`, and `reset_at` fields.
 *
 * Note: `sourceId` is returned as an empty string. The caller is responsible
 * for filling it in after this function returns, as the pure parser has no
 * knowledge of which source produced the body.
 * @param body - Raw text body potentially containing rate limit information
 * @returns Parsed rate limit with an empty `sourceId`, or `null` when absent or unparseable
 */
export function parseRateLimitFromBody(body: string): ReviewSourceRateLimit | null {
  const startMarker = '<!-- review_rate_limit_status_start -->';
  const endMarker = '<!-- review_rate_limit_status_end -->';

  const startIdx = body.indexOf(startMarker);
  if (startIdx === -1) return null;

  const contentStart = startIdx + startMarker.length;
  const endIdx = body.indexOf(endMarker, contentStart);
  const jsonText = endIdx !== -1 ? body.slice(contentStart, endIdx).trim() : null;
  if (!jsonText) return null;

  try {
    const parsed: unknown = JSON.parse(jsonText);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const raw = parsed as Record<string, unknown>;
    const remaining = typeof raw['remaining'] === 'number' ? raw['remaining'] : null;
    const limit = typeof raw['limit'] === 'number' ? raw['limit'] : null;
    const resetAt = typeof raw['reset_at'] === 'string' ? Date.parse(raw['reset_at']) : null;

    if (remaining === null || limit === null || resetAt === null || isNaN(resetAt)) {
      return null;
    }

    return {
      // sourceId is unknown at pure-parse time; callers must fill it in.
      sourceId: '',
      remaining,
      limit,
      resetsAt: resetAt,
      lastUpdatedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Nitpick section parsing (from review body)
// ---------------------------------------------------------------------------

/**
 * Convert a single nitpick block text into a {@link ReviewFinding}.
 * @param block - Raw text of one nitpick finding
 * @param file - File path this nitpick applies to (may be empty string)
 * @param params - Processing parameters carrying sourceId and target
 * @param reviewId - Numeric ID of the parent VCS review
 * @param reviewTimestamp - Epoch ms when the parent review was submitted; falls
 *   back to `Date.now()` when the VCS API did not supply a timestamp
 * @returns Structured nitpick finding
 */
function nitpickBlockToFinding(
  block: string,
  file: string,
  params: ProcessReviewBodyParams,
  reviewId: number,
  reviewTimestamp: number,
): ReviewFinding {
  const cleaned = stripCodeRabbitMetadata(block);
  const summary = extractSummaryLine(cleaned);
  const explanation = extractExplanation(cleaned);
  const message = buildMessage(summary, explanation) || cleaned;

  const suggestedChanges = file ? extractDiffSuggestions(cleaned, file) : [];

  // Stable review-body ID per AD-15
  const startLine = 0;
  const id = `${params.sourceId}:review-body:${reviewId}:${file}:${startLine}:${contentHash(message, suggestedChanges)}`;

  return {
    id,
    target: params.target,
    sourceId: params.sourceId,
    reviewer: 'coderabbit',
    origin: 'review-body',
    threadId: null,
    severity: 'nitpick',
    file: file || null,
    startLine: null,
    endLine: null,
    message,
    agentPrompt: null,
    suggestedChanges,
    status: 'open',
    addressedBy: null,
    addressedAt: null,
    verifiedAt: null,
    dismissedReason: null,
    createdAt: reviewTimestamp,
    updatedAt: reviewTimestamp,
    rawCommentId: null,
  };
}

/**
 * Parse all nitpick findings from the nitpick `<details>` section of a review body.
 *
 * Nitpicks are NOT posted as inline comments — they only appear in the review body.
 * Each finding is associated with a file path extracted from a nested `<details>` heading.
 * @param nitpickContent - Inner text of the `🧹 Nitpick comments` details block
 * @param params - Processing parameters carrying sourceId and target
 * @param reviewId - Numeric ID of the parent VCS review (for stable ID generation)
 * @param reviewTimestamp - Epoch ms when the parent review was submitted (for
 *   createdAt/updatedAt on the produced findings)
 * @returns Array of structured nitpick findings
 */
export function parseNitpickSection(
  nitpickContent: string,
  params: ProcessReviewBodyParams,
  reviewId: number,
  reviewTimestamp: number,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  // Each file-level nitpick starts with a nested <details> block whose summary is the file path
  const fileBlockRe = /<details>\s*<summary>([^<]*(?:<(?!\/summary>)[^<]*)*)<\/summary>([\s\S]*?)<\/details>/gi;
  let fileMatch: RegExpExecArray | null;

  while ((fileMatch = fileBlockRe.exec(nitpickContent)) !== null) {
    const filePath = fileMatch[1].trim();
    const fileContent = fileMatch[2].trim();

    // Within a file block, individual findings are separated by `---` or blank lines
    const blocks = fileContent
      .split(/\n---+\n/)
      .map((b) => b.trim())
      .filter(Boolean);

    for (const block of blocks) {
      findings.push(nitpickBlockToFinding(block, filePath, params, reviewId, reviewTimestamp));
    }
  }

  // Fallback: if no nested file blocks, treat entire section as a single nitpick
  if (findings.length === 0 && nitpickContent.trim()) {
    findings.push(nitpickBlockToFinding(nitpickContent, '', params, reviewId, reviewTimestamp));
  }

  return findings;
}

// ---------------------------------------------------------------------------
// IReviewerProcessor implementation
// ---------------------------------------------------------------------------

/**
 * CodeRabbit reviewer processor.
 *
 * Implements {@link IReviewerProcessor} for stateless transformation of raw
 * CodeRabbit VCS data (inline comments and review bodies) into normalized
 * {@link ReviewFinding} records.
 *
 * CodeRabbit posts two tiers of findings:
 * 1. **Inline comments** (`pulls/{n}/comments`) — actionable, severity-flagged
 *    findings posted directly on diff lines.
 * 2. **Review body** (`pulls/{n}/reviews`) — nitpick comments NOT posted inline,
 *    plus an optional consolidated AI-agent prompt and walkthrough summary.
 *
 * This processor parses both tiers and normalizes them into {@link ReviewFinding}
 * records with stable, deterministic IDs (per AD-15 — no nanoid).
 */
export const codeRabbitProcessor: IReviewerProcessor = {
  id: 'makaio/coderabbit',
  displayName: 'CodeRabbit',
  capabilityId: 'reviewer-processor' as const,
  reviewer: 'coderabbit',
  processorKey: 'makaio/coderabbit',
  priority: 0,
  botAuthors: ['coderabbitai[bot]'] as readonly string[],

  /**
   * Process CodeRabbit inline comments into findings.
   * @param params - Parameters containing sourceId, target, and raw comments
   * @returns Array of review findings extracted from inline comments
   */
  processComments(params: ProcessCommentsParams): ReviewFinding[] {
    const findings: ReviewFinding[] = [];
    for (const comment of params.comments) {
      const finding = commentToFinding(comment, params);
      if (finding) findings.push(finding);
    }
    return findings;
  },

  /**
   * Process CodeRabbit review bodies into findings.
   *
   * Extracts nitpick comments from the `🧹 Nitpick comments` details block
   * present in each review body.
   * @param params - Parameters containing sourceId, target, and raw reviews
   * @returns Array of nitpick findings extracted from review bodies
   */
  processReviewBody(params: ProcessReviewBodyParams): ReviewFinding[] {
    const findings: ReviewFinding[] = [];
    for (const review of params.reviews) {
      const body = review.body;
      if (!body) continue;

      const reviewTimestamp = review.submittedAt !== null ? Date.parse(review.submittedAt) : Date.now();

      const cleaned = stripCodeRabbitMetadata(body);
      const nitpickContent = extractDetailsBlock(cleaned, '🧹 Nitpick comments');
      if (nitpickContent) {
        findings.push(...parseNitpickSection(nitpickContent, params, review.id, reviewTimestamp));
      }
    }
    return findings;
  },

  /**
   * Parse CodeRabbit rate limit information from a body string.
   *
   * CodeRabbit embeds rate limit state in HTML comments using the marker
   * `<!-- review_rate_limit_status_start -->`.
   * @param body - Raw text body potentially containing rate limit information
   * @returns Parsed rate limit, or `null` when absent or unparseable
   */
  parseRateLimit(body: string): ReviewSourceRateLimit | null {
    return parseRateLimitFromBody(body);
  },

  /**
   * Extract the AI-optimized agent prompt from a CodeRabbit comment body.
   *
   * CodeRabbit embeds a `🤖 Prompt for AI Agents` details block in each
   * inline comment. This prompt is pre-formatted for direct use by AI agents.
   * @param body - Raw comment body text
   * @returns Agent-optimized instruction text, or `undefined` when absent
   */
  extractAgentPrompt(body: string): string | undefined {
    const content = extractDetailsBlock(body, '🤖 Prompt for AI Agents');
    if (!content) return undefined;
    // Strip HTML tags from the extracted prompt content
    return content.replace(/<[^>]+>/g, '').trim() || undefined;
  },
};
