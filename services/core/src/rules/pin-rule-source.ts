import type { JsonValue } from '@makaio/contracts';
import { JsonValueSchema, snapshotJsonBoundary } from '@makaio/contracts/shared';
import {
  ReactionRuleSchema,
  RuleExclusionSchema,
  RuleGroupSchema,
  RuleIdSchema,
  RuleSetRefSchema,
  type ReactionRule,
} from '@makaio/contracts/rules';
import { z } from 'zod';
import type { PinnedRuleSnapshot } from './types.js';

const SourceEnvelopeSchema = z.object({
  set: RuleSetRefSchema,
  rules: z.array(z.unknown()),
  groups: z.array(z.unknown()),
  excluded: z.array(z.unknown()),
});

interface SourceEntry {
  /** Identifier supplied by this entry, if it can be stored as text. */
  readonly id: string | null;
  /** Structurally valid rule, if present. */
  readonly rule: ReactionRule | undefined;
}

/** Check the text domain shared by the two storage engines.
 * @param value - A JSON key or string value.
 * @returns Whether both engines can reproduce the text.
 */
function isStorageText(value: string): boolean {
  return !value.includes('\u0000') && value.isWellFormed();
}

/** Snapshot an untrusted value in the JSON domain shared by both stores.
 * @param value - Contribution input or result.
 * @returns Detached value with its optional properties, if storable.
 */
export function pinStorageValue(value: unknown): unknown {
  const copy = snapshotJsonBoundary(value);
  if (!copy.ok) return undefined;
  try {
    JSON.stringify(copy.value, (key, entry: unknown) => {
      if (!isStorageText(key) || (typeof entry === 'string' && !isStorageText(entry))) {
        throw new Error('Value contains text that cannot be stored');
      }
      if (typeof entry === 'function' || typeof entry === 'symbol' || typeof entry === 'bigint') {
        throw new Error('Value is not JSON');
      }
      return entry;
    });
    return copy.value;
  } catch {
    return undefined;
  }
}

/** @param raw - One source entry, which may violate the contribution contract.
 * @param detached - Detached version, when the entry can be stored.
 * @returns The entry's usable identifier even if the remaining fields are invalid.
 */
function sourceId(raw: unknown, detached: unknown): string | null {
  try {
    const value = detached ?? raw;
    if (typeof value !== 'object' || value === null) return null;
    const id = RuleIdSchema.safeParse(Object.getOwnPropertyDescriptor(value, 'id')?.value);
    return id.success && isStorageText(id.data) ? id.data : null;
  } catch {
    return null;
  }
}

/** Validate the source envelope and pin each entry independently.
 * @param value - Effective set returned by the live source.
 * @returns The pinned snapshot and corresponding rules, or no usable set identity.
 */
export function pinRuleSource(value: unknown): { snapshot: PinnedRuleSnapshot; entries: SourceEntry[] } | undefined {
  const envelope = SourceEnvelopeSchema.safeParse(value);
  if (!envelope.success) return undefined;
  const { set, rules, groups, excluded } = envelope.data;
  if (pinStorageValue(set) === undefined) return undefined;
  const entries: SourceEntry[] = [];
  const pinnedRules: JsonValue[] = [];
  for (const raw of rules) {
    const detached = pinStorageValue(raw);
    const parsed = ReactionRuleSchema.safeParse(detached);
    entries.push({ id: sourceId(raw, detached), rule: parsed.data });
    // JSON serialization omits explicitly undefined optional properties.
    const serialized = JSON.stringify(detached);
    const pinned = serialized === undefined ? undefined : JsonValueSchema.safeParse(JSON.parse(serialized));
    pinnedRules.push(pinned?.data ?? null);
  }
  return {
    snapshot: {
      set,
      rules: pinnedRules,
      groups: groups.flatMap((group) => RuleGroupSchema.safeParse(pinStorageValue(group)).data ?? []),
      excluded: excluded.flatMap((item) => RuleExclusionSchema.safeParse(pinStorageValue(item)).data ?? []),
    },
    entries,
  };
}
