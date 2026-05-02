import type { JsonValue, SkillCatalogTurnEntry, SkillTurnEntry } from '@makaio/contracts';
import type { ResolvedContextRule } from '@makaio/services-core/context-rules';
import { safeJsonStringify } from './safeJsonStringify.js';

/**
 * A single serialized context entry ready for adapter-specific formatting.
 */
export interface SerializedContextBlock {
  /** XML tag name, e.g. 'skills', 'cwdChange' */
  readonly tag: string;
  /** Pre-formatted content (Markdown for skills/catalog, JSON for others) */
  readonly content: string;
}

/**
 * Escape XML-sensitive characters in block content.
 * @param value - Raw block content to escape for XML-like wrapping
 * @returns Escaped content safe for inclusion between XML-like tags
 */
function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll("'", '&apos;');
}

/**
 * Sanitize tag names for XML-like wrappers used in prompt context blocks.
 * @param tag - Raw context key used as an XML-like tag name
 * @returns Safe tag name containing only letters, digits, underscores, or hyphens
 */
function sanitizeTag(tag: string): string {
  const bodySanitized = tag.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (bodySanitized.length === 0) {
    return 'context';
  }
  return /^[A-Za-z_]/.test(bodySanitized) ? bodySanitized : `context_${bodySanitized}`;
}

/**
 * Format one context block as an XML-tagged text block.
 * @param tag - Block tag name (sanitized before rendering)
 * @param content - Block content (XML-escaped before rendering)
 * @returns XML-tagged text block safe for prompt injection
 */
export function formatContextBlockAsText(tag: string, content: string): string {
  const safeTag = sanitizeTag(tag);
  return `<${safeTag}>\n${escapeXml(content)}\n</${safeTag}>`;
}

/**
 * Runtime guard for one skill catalog turn entry.
 * @param value - Runtime value under inspection
 * @returns True when the value matches the prompt-facing catalog shape
 */
function isSkillCatalogTurnEntry(value: unknown): value is SkillCatalogTurnEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.name === 'string' &&
    typeof record.description === 'string' &&
    (record.compatibility === undefined || typeof record.compatibility === 'string')
  );
}

/**
 * Runtime guard for one skill turn entry.
 * @param value - Runtime value under inspection
 * @returns True when the value matches the prompt-facing active-skill shape
 */
function isSkillTurnEntry(value: unknown): value is SkillTurnEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const metadata = record.metadata;
  const metadataRecord = metadata as Record<string, unknown> | undefined;

  return (
    typeof record.name === 'string' &&
    typeof record.content === 'string' &&
    (record.license === undefined || typeof record.license === 'string') &&
    (record.compatibility === undefined || typeof record.compatibility === 'string') &&
    (record.allowedTools === undefined || typeof record.allowedTools === 'string') &&
    (metadata === undefined ||
      (typeof metadata === 'object' &&
        metadata !== null &&
        Object.values(metadataRecord ?? {}).every((value) => typeof value === 'string')))
  );
}

/**
 * Format turn-context skill catalog entries as compact markdown bullets.
 * @param value - Raw turn-context payload
 * @returns Markdown content when valid catalog entries exist
 */
function formatSkillCatalog(value: JsonValue): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const lines = value
    .filter(isSkillCatalogTurnEntry)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) =>
      entry.compatibility
        ? `- ${entry.name}: ${entry.description} Compatibility: ${entry.compatibility}`
        : `- ${entry.name}: ${entry.description}`,
    );

  return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * Format active skills as markdown sections.
 * @param value - Raw turn-context payload
 * @returns Markdown content when valid skill entries exist
 */
function formatSkills(value: JsonValue): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const sections = value
    .filter(isSkillTurnEntry)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((skill) => {
      const lines = [`## ${skill.name}`];
      if (skill.compatibility) {
        lines.push(`Compatibility: ${skill.compatibility}`);
      }
      lines.push(skill.content);
      return lines.join('\n');
    });

  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

type RenderableContextRuleEntry = Pick<ResolvedContextRule, 'id' | 'name' | 'priority' | 'renderedContent'>;

/**
 * Runtime guard for the rendering-relevant subset of a resolved context rule.
 * @param value - Runtime value under inspection
 * @returns True when the value has the fields needed for prompt serialization
 */
function isResolvedContextRuleEntry(value: unknown): value is RenderableContextRuleEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.priority === 'number' &&
    typeof record.renderedContent === 'string'
  );
}

/**
 * Format resolved context rules as canonical markdown sections.
 *
 * Each entry renders as `## <name>\n<renderedContent>`, joined with double
 * newlines, matching the canonical rendering contract described in
 * `docs/plans/done/2026-04-20-context-rules-design.md`.
 * @param value - Raw turn-context payload
 * @returns Markdown content when valid resolved context rule entries exist
 */
// No explicit sort here — the rules engine already returns entries in
// priority order, so re-sorting would hide the source-of-truth contract.
function formatContextRules(value: JsonValue): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const sections = value
    .filter(isResolvedContextRuleEntry)
    .map((entry) => `## ${entry.name}\n${entry.renderedContent}`);

  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

const SPECIAL_KEYS = ['skillCatalog', 'skills', 'contextRules'] as const;
type SpecialTurnContextTag = (typeof SPECIAL_KEYS)[number];

/**
 * Serialize a MessageHandle's turnContext into ordered text blocks.
 *
 * All non-null, non-undefined keys are serialized. The `skillCatalog`,
 * `skills`, and `contextRules` keys get dedicated markdown formatting;
 * all other keys are JSON-serialized.
 *
 * Each adapter converts these blocks to its wire format:
 * - Claude SDK: each block → prependContextBlock(msg, tag, content)
 * - Anthropic/OpenAI: join and prepend to user message
 * - Gemini: push as requestPart
 * - CLI/Copilot: prepend to prompt string
 * - Codex: push as userInput
 * @param turnContext - The context record from MessageHandle.turnContext
 * @returns Ordered blocks: skillCatalog, skills, contextRules, then remaining keys alphabetical.
 *          Empty when turnContext is nullish or empty.
 */
export function serializeTurnContext(
  turnContext: Record<string, JsonValue | undefined> | undefined,
): SerializedContextBlock[] {
  if (!turnContext) return [];

  const blocks: SerializedContextBlock[] = [];

  const formatters: Record<SpecialTurnContextTag, (value: JsonValue) => string | undefined> = {
    skillCatalog: formatSkillCatalog,
    skills: formatSkills,
    contextRules: formatContextRules,
  };

  for (const key of SPECIAL_KEYS) {
    appendSpecialTurnContextBlock(blocks, key, turnContext[key], formatters[key]);
  }

  const excludedKeys = new Set<string>(SPECIAL_KEYS);

  // All other keys: JSON-serialized, alphabetical order
  const otherKeys = Object.keys(turnContext)
    .filter((k) => {
      if (turnContext[k] == null) return false;
      return !excludedKeys.has(k);
    })
    .sort();

  for (const key of otherKeys) {
    blocks.push({ tag: key, content: safeJsonStringify(turnContext[key]) });
  }

  return blocks;
}

/**
 * Serialize one special turn-context key, preserving its dedicated ordering
 * while falling back to JSON for malformed non-empty payloads.
 * @param blocks - Output block accumulator
 * @param tag - Special turn-context key
 * @param value - Raw turn-context payload
 * @param formatter - Dedicated formatter for valid payloads
 */
function appendSpecialTurnContextBlock(
  blocks: SerializedContextBlock[],
  tag: SpecialTurnContextTag,
  value: JsonValue | undefined,
  formatter: (value: JsonValue) => string | undefined,
): void {
  if (value == null) {
    return;
  }

  const formatted = formatter(value);
  if (formatted !== undefined) {
    blocks.push({ tag, content: formatted });
    return;
  }

  if (Array.isArray(value) && value.length === 0) {
    return;
  }

  blocks.push({ tag, content: safeJsonStringify(value) });
}

/**
 * Format serialized context blocks as XML-tagged text.
 * Convenience for adapters that prepend context as plain text to the user message.
 * @param blocks - Blocks from serializeTurnContext()
 * @returns Single string with each block wrapped in XML tags, separated by newlines.
 *          Empty string when no blocks.
 */
export function formatContextBlocksAsText(blocks: SerializedContextBlock[]): string {
  if (blocks.length === 0) return '';
  return blocks.map((b) => formatContextBlockAsText(b.tag, b.content)).join('\n\n');
}
