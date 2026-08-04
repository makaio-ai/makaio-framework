// @ts-check

/**
 * Shared ESLint base configuration for the makaio codebase.
 *
 * Canonical source: framework/scripts/eslint-base.mjs
 * Consumed by:
 *   - framework/eslint.config.mjs   (standalone)
 *   - <repo-root>/eslint.config.mjs (full workspace — adds host-specific overrides)
 *
 * Returns an array of flat config objects ready to spread into tseslint.config().
 */

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import { jsdoc } from 'eslint-plugin-jsdoc';
import tsdoc from 'eslint-plugin-tsdoc';

// Keys are ESLint rule IDs disabled because Biome now owns the same checks.
// Several Biome equivalents use different names, e.g. no-fallthrough maps to
// noFallthroughSwitchClause, prefer-const maps to useConst, and
// @typescript-eslint/no-explicit-any maps to noExplicitAny.
const BIOME_OWNED_TYPESCRIPT_RULES = {
  'constructor-super': 'off',
  'for-direction': 'off',
  'no-case-declarations': 'off',
  'no-compare-neg-zero': 'off',
  'no-const-assign': 'off',
  'no-constant-binary-expression': 'off',
  'no-constant-condition': 'off',
  'no-control-regex': 'off',
  'no-debugger': 'off',
  'no-dupe-args': 'off',
  'no-dupe-class-members': 'off',
  'no-dupe-else-if': 'off',
  'no-dupe-keys': 'off',
  'no-duplicate-case': 'off',
  'no-empty-character-class': 'off',
  'no-empty-pattern': 'off',
  'no-empty-static-block': 'off',
  'no-ex-assign': 'off',
  'no-extra-boolean-cast': 'off',
  'no-fallthrough': 'off',
  'no-func-assign': 'off',
  'no-global-assign': 'off',
  'no-import-assign': 'off',
  'no-irregular-whitespace': 'off',
  'no-loss-of-precision': 'off',
  'no-misleading-character-class': 'off',
  'no-new-native-nonconstructor': 'off',
  'no-nonoctal-decimal-escape': 'off',
  'no-redeclare': 'off',
  'no-regex-spaces': 'off',
  'no-self-assign': 'off',
  'no-setter-return': 'off',
  'no-shadow-restricted-names': 'off',
  'no-sparse-arrays': 'off',
  'no-this-before-super': 'off',
  'no-unreachable': 'off',
  'no-unsafe-finally': 'off',
  'no-unsafe-negation': 'off',
  'no-unsafe-optional-chaining': 'off',
  'no-unused-labels': 'off',
  'no-useless-backreference': 'off',
  'no-useless-catch': 'off',
  'no-useless-escape': 'off',
  'no-var': 'off',
  'no-with': 'off',
  'prefer-const': 'off',
  'prefer-rest-params': 'off',
  'require-yield': 'off',
  'use-isnan': 'off',
  'valid-typeof': 'off',
  '@typescript-eslint/no-array-constructor': 'off',
  '@typescript-eslint/no-explicit-any': 'off',
  '@typescript-eslint/no-extra-non-null-assertion': 'off',
  '@typescript-eslint/no-misused-new': 'off',
  '@typescript-eslint/no-namespace': 'off',
  '@typescript-eslint/no-non-null-asserted-optional-chain': 'off',
  '@typescript-eslint/no-unnecessary-type-constraint': 'off',
  '@typescript-eslint/no-unsafe-declaration-merging': 'off',
  '@typescript-eslint/prefer-as-const': 'off',
  '@typescript-eslint/prefer-namespace-keyword': 'off',
};

/**
 * The wildcard re-export ban.
 *
 * Exported because `no-restricted-syntax` takes its whole selector list at
 * once: a downstream config that adds a selector for its own layer replaces
 * this one under flat-config last-wins semantics unless it carries it along.
 */
export const NO_EXPORT_ALL = {
  selector: 'ExportAllDeclaration',
  message: 'Use explicit named re-exports instead of export *. See docs/memos/2026-05-02-knip.md.',
};

/** What a second `adapter.rehydrateAgent` producer is told to use instead. */
export const REHYDRATE_PRODUCER_MESSAGE =
  'Rehydrate through runReservedRehydrate (services-core/session): a rehydrate that has not reserved the ' +
  'provider session is a second driver of a live conversation.';

/**
 * The selector that names a second `adapter.rehydrateAgent` producer.
 *
 * Exported whole, message included, because the rule has two mounts — these
 * sources, and the product sources a composing host adds — and a selector
 * restated at the second mount is a rule that can be narrowed on one side only.
 */
export const NO_REHYDRATE_SUBJECT_ACCESS = {
  selector: "MemberExpression[object.name='AdapterSubjects'][property.name='rehydrateAgent']",
  message: REHYDRATE_PRODUCER_MESSAGE,
};

/** What a new provider-key publisher is told. */
export const PROVIDER_KEY_PUBLICATION_MESSAGE =
  'This emitted payload names a provider session literally. Take the value from publishedProviderKey() ' +
  '(adapter/adapter-provider-key-publication.ts): an attempt whose caller settles the key must not publish it ' +
  'first. This rule reads literals only — passing the same value through a variable evades it, and evading it is ' +
  'not permission.';

/**
 * The one-publisher gate for provider-session keys.
 *
 * A provider key has one publisher per attempt, the party that claims it, and
 * the runtime gate answers that for every route that asks it. This layer is what
 * makes a route that *forgets* to ask fail loudly: an emitted payload is the
 * shape every one of the missed routes had, and each was found by a reviewer
 * rather than by the build. The sanctioned publishers are exempt by name, and a
 * new one has to say why it is not a publication.
 *
 * **Stated plainly: it matches literals, and it is a review aid, not a proof.**
 * The selector sees a payload that names the field where it is written; a payload
 * assembled in a variable, spread from a helper's result or built by a factory
 * passes it untouched. What the rule buys is that the *ordinary* shape — the one
 * every route missed so far had — cannot be added silently.
 *
 * The proof is elsewhere and is dynamic: the gate itself, which every route
 * takes its key from, and the emitter case that drives a payload *already
 * carrying* a key through the one funnel every enriched event crosses and shows
 * it does not come out. Making the static half total needs the key to be a value
 * only the gate can produce — a branded `PublishedProviderKey` that no other
 * expression satisfies — which is contract surface and is on the Wave-4
 * watchlist. Widening this selector into data-flow tracking instead would buy
 * the appearance of that guarantee without the guarantee.
 * @param basePath - Directory these sources sit in, for a config that mounts
 *   them from an outer root. Omit when the config lives beside them.
 * @returns The flat-config layer enforcing the gate.
 */
export function createProviderKeyPublicationGuard(basePath) {
  return [
    {
      ...(basePath === undefined ? {} : { basePath }),
      files: ['adapters/core/src/**/*.ts'],
      ignores: [
        // The movement seam's own announcement, gated by the tracker it belongs
        // to, and the two lifecycle events, gated where they are built.
        'adapters/core/src/agent/agent-adapter-session-movement.ts',
        'adapters/core/src/adapter/ai-adapter-start-persistence.ts',
        // Evaluated and kept: these report a session that has *closed* or the
        // usage it accrued. Neither advertises a key as resumable, which is what
        // the gate protects.
        'adapters/core/src/adapter/ai-adapter.ts',
        // The connector stamps its own identity on every *scoped* event it
        // emits. Those are adapter-internal; the ones that reach the global bus
        // cross through the payload emitter, which strips the key while it is
        // not this attempt's to publish.
        'adapters/core/src/connector/agent-connector.ts',
        '**/testing/**',
        '**/__tests__/**',
        '**/*.test.ts',
      ],
      rules: {
        'no-restricted-syntax': [
          'error',
          NO_EXPORT_ALL,
          {
            selector: "CallExpression[callee.property.name=/^emit(Global)?$/] Property[key.name='adapterSessionId']",
            message: PROVIDER_KEY_PUBLICATION_MESSAGE,
          },
        ],
      },
    },
  ];
}

/**
 * The one-producer gate for `adapter.rehydrateAgent`.
 *
 * Every service-owned rehydrate must reserve the provider session it is about
 * to speak to; a second, unreserved producer is a runtime driving a
 * conversation another generation owns. The gate that actually holds is
 * structural — the raw dispatch primitive is exported from no barrel, so it is
 * unreachable outside `services/core/src/session`. These layers narrow the
 * surface inside that directory and name the seam for anyone adding a producer
 * elsewhere.
 *
 * Stated plainly: a caller that aliases or destructures the subject
 * (`const { rehydrateAgent } = AdapterSubjects`) evades the first layer. It is a
 * review aid, not a proof. The export removal is the part that cannot be aliased
 * around.
 *
 * **It lives here so that it holds wherever these sources are linted.** A gate
 * defined only in the config of a host that composes this package would leave
 * the package's own checkout ungated, which is exactly the checkout in which a
 * new producer is written.
 * @param basePath - Directory these sources sit in, for a config that mounts
 *   them from an outer root. Omit when the config lives beside them.
 * @returns The flat-config layers enforcing the gate.
 */
export function createRehydrateProducerGuard(basePath) {
  const mount = basePath === undefined ? {} : { basePath };
  return [
    {
      ...mount,
      files: ['**/*.ts'],
      ignores: [
        // The sanctioned dispatch primitive, and the adapter that handles the
        // subject — the two ends the rule exists to keep exclusive.
        'services/core/src/session/handlers/rehydrate-dispatch.ts',
        'adapters/core/**/*.ts',
        // Test-host composition helpers register the subject's *handler*, which
        // is the same end of the seam the adapter sits at.
        '**/testing/**',
        '**/__tests__/**',
        '**/*.test.ts',
      ],
      rules: {
        // The base selector travels with it: this rule takes its whole list at
        // once, so adding one here would otherwise drop the wildcard re-export
        // ban for every file this layer covers.
        'no-restricted-syntax': ['error', NO_EXPORT_ALL, NO_REHYDRATE_SUBJECT_ACCESS],
      },
    },
    // The dispatch primitive itself may only be imported by the reserved
    // rehydrate. It is exported from no barrel, so this covers the one directory
    // that can still reach it by relative path.
    {
      ...mount,
      files: ['services/core/src/session/**/*.ts'],
      ignores: ['services/core/src/session/handlers/reserved-rehydrate.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                regex: 'rehydrate-dispatch',
                message:
                  'dispatchAgentRehydrate is the raw primitive runReservedRehydrate owns; call runReservedRehydrate instead.',
              },
            ],
          },
        ],
      },
    },
  ];
}

/**
 * Build the shared flat-config layers every repository in this family starts from.
 * @param customRules - The custom rule implementations, keyed by rule name.
 * @param options - Repository-specific additions; `ignores` is appended to the shared ignore list.
 * @returns The flat-config layers, in order.
 */
export function createBaseConfig(customRules, options = {}) {
  const { noComplexInlineReturnType, preferBusFilter, noSubjectBracketNotation } = customRules;
  const extraIgnores = options.ignores ?? [];

  return [
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    jsdoc({
      config: 'flat/requirements-typescript',
    }),
    {
      rules: {
        'jsdoc/require-example': 'off',
        'jsdoc/require-next-type': 'off',
        'jsdoc/require-yields-type': 'off',
        'jsdoc/require-property': 'off',
        'jsdoc/require-property-name': 'off',
        'jsdoc/require-property-description': 'off',
      },
    },

    // ── Ignores ───────────────────────────────────────────────────────────────
    {
      ignores: [
        '**/generated/*',
        '**/dist/*',
        '**/build/*',
        '**/coverage/*',
        '**/*.md',
        '**/node_modules/**',
        // Agent-session worktrees are full nested checkouts; linting must never
        // traverse them, independent of .gitignore correctness.
        '**/.claude/worktrees/**',
        ...extraIgnores,
      ],
    },

    // ── Main TypeScript rules ─────────────────────────────────────────────────
    {
      plugins: {
        tsdoc,
        custom: {
          rules: {
            'no-complex-inline-return-type': noComplexInlineReturnType,
            'prefer-bus-filter': preferBusFilter,
            'no-subject-bracket-notation': noSubjectBracketNotation,
          },
        },
      },
      files: ['**/*.{ts,tsx}'],
      extends: [importPlugin.flatConfigs.recommended, importPlugin.flatConfigs.typescript],
      rules: {
        'tsdoc/syntax': 'error',
        'import/no-unresolved': 'off',
        'import/namespace': 'off',
        'import/no-duplicates': 'off',
        'jsdoc/require-example': 'off',
        'jsdoc/require-throws-type': 'off',
        'jsdoc/require-param-description': 'error',
        'jsdoc/require-param': ['error', { checkDestructured: false }],
        'jsdoc/require-returns': 'error',
        'jsdoc/require-yields': 'off',
        'jsdoc/tag-lines': ['error', 'never', { startLines: 0 }],
        'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
        '@typescript-eslint/explicit-member-accessibility': 'warn',
        complexity: ['warn', { max: 20 }],
        'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
        '@typescript-eslint/prefer-as-const': 'error',
        '@typescript-eslint/ban-ts-comment': [
          'error',
          { 'ts-expect-error': 'allow-with-description', minimumDescriptionLength: 10 },
        ],
        'custom/no-complex-inline-return-type': ['error', { maxProperties: 1 }],
        'custom/prefer-bus-filter': 'warn',
        'custom/no-subject-bracket-notation': 'warn',
        'no-restricted-syntax': ['error', NO_EXPORT_ALL],
        'no-console': ['error', { allow: ['warn', 'error', 'debug', 'info'] }],
        '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            args: 'after-used',
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            ignoreRestSiblings: true,
            destructuredArrayIgnorePattern: '^_',
            caughtErrors: 'all',
            caughtErrorsIgnorePattern: '^_',
          },
        ],
        ...BIOME_OWNED_TYPESCRIPT_RULES,
      },
      settings: {
        'import/resolver': { node: { extensions: ['.js', '.jsx'] } },
      },
    },

    // ── Test file overrides ───────────────────────────────────────────────────
    {
      files: [
        '**/*.test.{ts,tsx}',
        '**/*.test.*.{ts,tsx}',
        '**/test/**/*.ts',
        '**/test-*.ts',
        '**/__tests__/**/*.ts',
        '**/testing/**/*.ts',
      ],
      rules: {
        '@typescript-eslint/explicit-member-accessibility': 'off',
        'jsdoc/require-param-description': 'off',
        'jsdoc/require-returns': 'off',
        'jsdoc/require-jsdoc': 'off',
        complexity: 'off',
        'max-lines-per-function': 'off',
        'custom/no-complex-inline-return-type': 'off',
        'no-console': 'off',
        'max-lines': 'off',
      },
    },

    // ── Build scripts & demos ────────────────────────────────────────────────
    {
      files: ['**/*.test.ts', '**/*.spec.ts', '**/build.ts', '**/demo.ts', '**/__tests__/**', '**/test/**'],
      rules: {
        'no-console': 'off',
        'max-lines': 'off',
      },
    },

    // ── CLI scripts (framework/scripts/, scripts/) ───────────────────────────
    {
      files: ['**/scripts/**/*.ts'],
      rules: {
        'no-console': 'off',
        'jsdoc/require-returns': 'off',
        'jsdoc/require-param-description': 'off',
        'tsdoc/syntax': 'off',
      },
    },

    // ── TSX: relax metrics and docs for component files ──────────────────────
    {
      files: ['**/*.tsx'],
      rules: {
        'max-lines-per-function': 'off',
        'jsdoc/require-returns': 'off',
        complexity: 'off',
      },
    },

    // ── Hook files: relax line limits for stateful orchestration ──────────────
    {
      files: ['**/use*.ts'],
      rules: {
        complexity: 'off',
        'max-lines-per-function': ['warn', { max: 300, skipBlankLines: true, skipComments: true }],
      },
    },
  ];
}
