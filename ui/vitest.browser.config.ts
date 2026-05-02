import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import getPort from 'get-port';

const PREFERRED_BROWSER_API_PORT = 63_325;

/**
 * Resolve a per-invocation browser API port so concurrent Vitest browser runs
 * do not contend for Vitest's built-in default port.
 * @returns Free TCP port for the Vitest browser API server.
 */
async function resolveBrowserApiPort(): Promise<number> {
  return getPort({ port: PREFERRED_BROWSER_API_PORT });
}

// Top-level await is valid in ESM config modules — Vite/Vitest natively
// supports async config evaluation without wrapping in defineConfig(async ...).
const browserApiPort = await resolveBrowserApiPort();
const repoNodeModules = fileURLToPath(new URL('../../node_modules', import.meta.url));

/**
 * Vitest browser configuration for `ui/views/` browser-specific tests.
 *
 * Uses Playwright/Chromium to run tests that require real browser APIs
 * (e.g., layout measurement, canvas, drag-and-drop).
 *
 * Test files must be named `*.browser.test.{ts,tsx}` under `ui/views/src/`
 * to be picked up.
 *
 * Run standalone via `yarn test:e2e:browser`.
 * Example:
 * ```bash
 * # Standalone
 * yarn test:e2e:browser
 *
 * # Specific file
 * yarn test:e2e:browser ui/views/src/...browser.test.tsx
 * ```
 */
export default defineConfig({
  plugins: [react()],
  // resolve.tsconfigPaths is a Vite 8 native feature (not a plugin).
  // It resolves path aliases from tsconfig.json automatically.
  resolve: {
    tsconfigPaths: true,
  },
  css: {
    preprocessorOptions: {
      scss: {
        // Resolve workspace packages from the workspace node_modules.
        loadPaths: [repoNodeModules],
        silenceDeprecations: ['legacy-js-api'],
      },
    },
  },
  test: {
    name: 'framework-ui-browser',
    browser: {
      api: {
        port: browserApiPort,
      },
      enabled: true,
      provider: playwright(),
      instances: [{ browser: 'chromium', headless: true }],
    },
    root: import.meta.dirname,
    include: ['views/src/**/*.browser.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    globals: true,
  },
});
