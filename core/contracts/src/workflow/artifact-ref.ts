import { z } from 'zod';

/** Explicit workflow artifact reference supplied by an execution starter. */
export const WorkflowArtifactRefSchema = z.object({
  /** Artifact kind string. */
  kind: z.string().min(1),
  /** Artifact identifier within its kind. */
  id: z.string().min(1),
});

export type WorkflowArtifactRef = z.infer<typeof WorkflowArtifactRefSchema>;

/**
 * Canonical escaped `"kind:id"` serialization for use as record keys.
 * @param ref - Artifact reference to serialize.
 * @returns Canonical string key in `"kind:id"` format.
 */
export function serializeArtifactRef(ref: WorkflowArtifactRef): string {
  return `${escapeArtifactRefComponent(ref.kind)}:${escapeArtifactRefComponent(ref.id)}`;
}

/**
 * Inverse of {@link serializeArtifactRef}.
 * @param key - Canonical `"kind:id"` string to parse.
 * @returns Parsed artifact reference.
 */
export function parseArtifactRef(key: string): WorkflowArtifactRef {
  const idx = findArtifactRefSeparator(key);
  if (idx < 1) throw new Error(`Invalid artifact ref key: ${key}`);
  const id = unescapeArtifactRefComponent(key.slice(idx + 1));
  if (id.length === 0) throw new Error(`Invalid artifact ref key (empty id): ${key}`);
  return { kind: unescapeArtifactRefComponent(key.slice(0, idx)), id };
}

/**
 * @param value - Raw artifact ref component.
 * @returns Component escaped for the canonical artifact-ref key format.
 */
function escapeArtifactRefComponent(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

/**
 * @param key - Serialized artifact-ref key.
 * @returns Index of the first unescaped separator colon, or -1.
 */
function findArtifactRefSeparator(key: string): number {
  let escaped = false;
  for (let i = 0; i < key.length; i++) {
    const ch = key[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === ':') return i;
  }
  return -1;
}

/**
 * @param value - Escaped artifact-ref key component.
 * @returns Unescaped component value.
 */
function unescapeArtifactRefComponent(value: string): string {
  let result = '';
  let escaped = false;
  for (const ch of value) {
    if (escaped) {
      if (ch !== '\\' && ch !== ':') {
        throw new Error(`Invalid artifact ref key component: ${value}`);
      }
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    result += ch;
  }
  if (escaped) throw new Error(`Invalid artifact ref key component: ${value}`);
  return result;
}
