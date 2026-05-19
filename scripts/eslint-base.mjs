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
 * Creates the shared flat ESLint configuration used by framework and product roots.
 * @param {{ noComplexInlineReturnType: any, preferBusFilter: any, noSubjectBracketNotation: any }} customRules - Local custom rule implementations.
 * @param {{ ignores?: string[] }} [options] - Optional root-specific ignore patterns.
 * @returns Flat ESLint configuration entries.
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
        'no-restricted-syntax': [
          'error',
          {
            selector: 'ExportAllDeclaration',
            message: 'Use explicit named re-exports instead of export *. See docs/memos/2026-05-02-knip.md.',
          },
        ],
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
