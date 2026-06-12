/**
 * CI shard coverage checker.
 *
 * Verifies that every Vitest project defined in the config is claimed by at
 * least one CI shard, and that every claimed shard matches an actual project.
 *
 * Both directions are checked: unclaimed projects (tests that would silently
 * never run in CI) and stale claims (shard names with no matching project).
 * @packageDocumentation
 */

/**
 * Input to the shard coverage check.
 */
export interface ShardCoverageInput {
  /** All Vitest project names defined in the config. */
  readonly projectNames: readonly string[];
  /** Shard names claimed by the CI workflow. */
  readonly claimedShards: readonly string[];
  /**
   * Projects explicitly exempted from the "must be claimed" requirement.
   * Each entry must have a corresponding comment in the calling entrypoint
   * explaining why it is intentionally unclaimed.
   */
  readonly intentionallyUnclaimed?: readonly string[];
}

/**
 * Check that every Vitest project is covered by a CI shard, and that every
 * claimed shard matches an actual project.
 * @param input - Project names, claimed shards, and optional unclaimed allowlist.
 * @returns Human-readable issue descriptions; empty when coverage is complete.
 */
export function checkShardCoverage(input: ShardCoverageInput): string[] {
  const { projectNames, claimedShards, intentionallyUnclaimed = [] } = input;
  const issues: string[] = [];

  const exemptSet = new Set(intentionallyUnclaimed);
  const claimedSet = new Set(claimedShards);
  const projectSet = new Set(projectNames);

  for (const project of projectNames) {
    if (!claimedSet.has(project) && !exemptSet.has(project)) {
      issues.push(
        `Project "${project}" exists in the Vitest config but no CI shard claims it. ` +
          `Either add it to the CI shard matrix or add it to intentionallyUnclaimed with a justification.`,
      );
    }
  }

  for (const shard of claimedShards) {
    if (!projectSet.has(shard)) {
      issues.push(
        `CI shard "${shard}" is claimed in the workflow but no matching Vitest project exists. ` +
          `Remove the stale shard from the workflow's test_shards list.`,
      );
    }
  }

  return issues;
}

/**
 * Extract the `test_shards` JSON array from a CI workflow YAML string.
 *
 * The workflow encodes the shard list as a JSON array inside a YAML string
 * value, e.g.:
 * ```yaml
 *   test_shards: '["Core", "Packages", "forks-required"]'
 * ```
 *
 * This function uses a targeted regex rather than a full YAML parser. If the
 * expected pattern is absent or the JSON is malformed, it throws — a silent
 * no-match must never produce a passing guard.
 * @param yaml - Raw YAML content of a CI workflow file.
 * @returns Parsed array of shard name strings.
 * @throws When `test_shards` key is not found, JSON is malformed, or value is
 *   not a string array.
 */
export function extractShardsFromWorkflowYaml(yaml: string): string[] {
  // Capture group 1: the quote character. Capture group 2: the JSON array.
  // The backreference \1 enforces that the same quote style closes the value.
  // The `s` (dotAll) flag makes `.` match newlines so multi-line array values
  // are handled correctly alongside the common single-line form.
  const match = /test_shards:\s*(['"])(\[.*?\])\1/s.exec(yaml);
  if (match === null) {
    throw new Error(
      'Could not locate a `test_shards` key with a JSON array value in the workflow YAML. ' +
        'The guard requires an explicit test_shards input to verify coverage.',
    );
  }

  // When the outer delimiter is a double-quote, YAML escapes inner double-quotes as \".
  // Unescape them so the captured content is valid JSON.
  const raw = match[1] === '"' ? match[2].replace(/\\"/g, '"') : match[2];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Failed to parse test_shards JSON value \`${raw}\`: ${String(cause)}`);
  }

  if (!Array.isArray(parsed) || !parsed.every((item): item is string => typeof item === 'string')) {
    throw new Error(`test_shards value must be a JSON string array; got: ${JSON.stringify(parsed)}`);
  }

  return parsed;
}
