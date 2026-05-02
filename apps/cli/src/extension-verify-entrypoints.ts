import type { ExtensionEntrypoints } from '@makaio/contracts';
import { entrypointStem, resolveConventionEntrypoint } from '@makaio/runtime-node/extension-validation';
import {
  failVerification,
  recordCheck,
  type ExtensionVerifyDiagnostic,
  type ExtensionVerifyState,
} from './extension-verify-model.js';

/**
 * Resolved descriptor entrypoints keyed by surface.
 */
export interface ResolvedEntrypoints {
  readonly server?: string;
  readonly browser?: string;
  readonly cli?: string;
}

/**
 * Resolve and verify all declared descriptor entrypoints.
 * @param state - Mutable verification state.
 * @param entrypoints - Descriptor entrypoints.
 * @returns Resolved absolute paths keyed by surface.
 */
export function resolveDeclaredEntrypoints(
  state: ExtensionVerifyState,
  entrypoints: ExtensionEntrypoints,
): ResolvedEntrypoints {
  return {
    server: verifyEntrypoint(state, 'server', entrypoints.server),
    browser: verifyEntrypoint(state, 'browser', entrypoints.browser),
    cli: verifyEntrypoint(state, 'cli', entrypoints.cli),
  };
}

/**
 * Verify one descriptor entrypoint and return its absolute resolved path.
 *
 * Tries `src/{stem}.ts` (dev) then `dist/{stem}.mjs` (production). Fails
 * when no candidate exists within the extension root.
 * @param state - Mutable verification state.
 * @param surface - Surface name for diagnostics.
 * @param entrypointValue - Entrypoint declaration from the descriptor (`true` or a stem string).
 * @returns Resolved absolute path, or `undefined` when the surface is absent.
 */
function verifyEntrypoint(
  state: ExtensionVerifyState,
  surface: keyof ExtensionEntrypoints,
  entrypointValue: true | string | undefined,
): string | undefined {
  if (entrypointValue === undefined) {
    recordCheck(state, {
      check: 'entrypoint',
      status: 'skipped',
      surface,
      diagnostics: [],
    });
    return undefined;
  }

  const stem = entrypointStem(surface, entrypointValue);
  const resolvedPath = resolveConventionEntrypoint(surface, entrypointValue, state.rootDir);

  if (!resolvedPath) {
    return failEntrypointCheck(state, surface, stem, 'entrypoint.no-candidate');
  }

  recordCheck(state, {
    check: 'entrypoint',
    status: 'passed',
    surface,
    entrypoint: stem,
    filePath: resolvedPath,
    diagnostics: [],
  });
  return resolvedPath;
}

/**
 * Record a failed entrypoint check and throw a typed verification error.
 * @param state - Mutable verification state.
 * @param surface - Declared surface.
 * @param stem - Entrypoint stem for diagnostics.
 * @param code - Stable diagnostic code.
 * @returns Never.
 */
function failEntrypointCheck(
  state: ExtensionVerifyState,
  surface: keyof ExtensionEntrypoints,
  stem: string,
  code: 'entrypoint.no-candidate',
): never {
  return failVerification(state, {
    check: 'entrypoint',
    status: 'failed',
    surface,
    entrypoint: stem,
    diagnostics: [createEntrypointDiagnostic(code, surface, stem)],
  });
}

/**
 * Build a structured entrypoint diagnostic.
 * @param code - Stable diagnostic code.
 * @param surface - Declared surface.
 * @param stem - Entrypoint stem.
 * @returns Structured diagnostic.
 */
function createEntrypointDiagnostic(
  code: 'entrypoint.no-candidate',
  surface: keyof ExtensionEntrypoints,
  stem: string,
): ExtensionVerifyDiagnostic {
  return {
    code,
    message: `${surface} entrypoint "${stem}" has no resolvable candidate: neither src/${stem}.ts nor dist/${stem}.mjs exists within the extension root`,
    surface,
    entrypoint: stem,
  };
}
