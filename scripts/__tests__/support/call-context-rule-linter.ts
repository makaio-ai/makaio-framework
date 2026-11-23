/**
 * Linter driver for the tests of the call-context ESLint rules.
 *
 * It builds its own `ESLint` with `overrideConfigFile: true`, so no repository config is loaded, and mounts exactly
 * one rule file under a test plugin name with the TypeScript parser. A rule is therefore tested on its own, with
 * nothing else enabled (see the warning in `process-start-probes.ts` on why configs are not mixed in one process).
 */
import { pathToFileURL } from 'node:url';
import { ESLint, type Rule } from 'eslint';
import tseslint from 'typescript-eslint';
import { frameworkRoot } from './process-start-probes';

/** The plugin name the rule under test is mounted under. */
const TEST_PLUGIN = 'rule-under-test';

/** The path probes are linted as; the file need not exist. */
const PROBE_FILE = 'probe.ts';

/** One reported problem of a probe. */
export interface RuleReport {
  /** The reported message text. */
  readonly message: string;
  /** The message ID declared by the rule, when it reports by ID. */
  readonly messageId: string | undefined;
  /** Line of the report, starting at 1. */
  readonly line: number;
}

/** A driver that lints sources with one mounted rule. */
export interface CallContextRuleLinter {
  /**
   * Lint a source with only the mounted rule enabled.
   * @param source - Source text of the probe.
   * @returns The problems the rule reported, in source order.
   */
  lint(source: string): Promise<readonly RuleReport[]>;
}

/**
 * Load the default export of a rule file.
 * @param ruleFile - Absolute path of the rule file.
 * @returns The rule module.
 * @throws {Error} When the file has no rule as default export.
 */
async function loadRule(ruleFile: string): Promise<Rule.RuleModule> {
  const loaded: { default?: Rule.RuleModule } = await import(pathToFileURL(ruleFile).href);
  if (!loaded.default) throw new Error(`Rule file has no default export: ${ruleFile}`);
  return loaded.default;
}

/**
 * Create a linter driver for one rule file.
 * @param ruleFile - Absolute path of the rule file to mount.
 * @returns The driver; every `lint` call runs a real ESLint over the given source.
 * @example const linter = await createCallContextRuleLinter(resolve(frameworkRoot, 'scripts/eslint-rules/x.js'));
 */
export async function createCallContextRuleLinter(ruleFile: string): Promise<CallContextRuleLinter> {
  const rule = await loadRule(ruleFile);
  const eslint = new ESLint({
    cwd: frameworkRoot,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        plugins: { [TEST_PLUGIN]: { rules: { rule } } },
        rules: { [`${TEST_PLUGIN}/rule`]: 'error' },
      },
    ],
  });
  return {
    async lint(source) {
      const [result] = await eslint.lintText(source, { filePath: PROBE_FILE });
      if (!result) throw new Error('ESLint returned no result for the probe');
      return result.messages.map((message) => ({
        message: message.message,
        messageId: message.messageId,
        line: message.line,
      }));
    },
  };
}
