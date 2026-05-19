// @ts-check

import tseslint from 'typescript-eslint';
import noComplexInlineReturnType from './scripts/eslint-rules/no-complex-inline-return-type.js';
import preferBusFilter from './scripts/eslint-rules/prefer-bus-filter.js';
import noSubjectBracketNotation from './scripts/eslint-rules/no-subject-bracket-notation.js';
import { createBaseConfig } from './scripts/eslint-base.mjs';

export default tseslint.config(
  ...createBaseConfig(
    {
      noComplexInlineReturnType,
      preferBusFilter,
      noSubjectBracketNotation,
    },
    {
      ignores: [
        // Plain CJS runtime scripts — not TypeScript source, exempt from TS/ESM rules
        'apps/electron/src/main/preload.cjs',
        'packages/native-session-supervisor/src/pty/bridge/*.cjs',
      ],
    },
  ),
);
