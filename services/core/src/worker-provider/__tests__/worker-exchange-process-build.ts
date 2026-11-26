import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';

/** Keep native and optional dependencies under the runtime's regular loader. */
const externalProcessDependencies: Plugin = {
  name: 'external-process-dependencies',
  setup(builder) {
    const installed = process.env['MAKAIO_WORKER_EXCHANGE_INSTALLED_ENTRY'];
    if (installed !== undefined) {
      // Local package acceptance can point the stock process at a separate
      // consumer module that imports the worker entry from the installed package.
      builder.onResolve({ filter: /workflow-worker\/worker-entry\.js$/ }, ({ importer }) =>
        importer.endsWith('worker-exchange-stock-process.ts')
          ? { path: resolve(installed), external: true }
          : undefined,
      );
    }
    const bundled = /^(?:@makaio\/|drizzle-orm(?:$|\/)|zod(?:$|\/)|hono(?:$|\/))/;
    builder.onResolve({ filter: /^[a-z@]/ }, ({ path }) => (bundled.test(path) ? undefined : { path, external: true }));
  },
};

/**
 * Precompile the isolated process entries once for Node and Bun. Bundle the
 * workspace graph together so nominal types and registries keep one identity.
 * @param outdir - Temporary directory that can resolve installed dependencies.
 */
export async function buildExchangeProcesses(outdir: string): Promise<void> {
  await build({
    entryPoints: ['host', 'peer', 'stock'].map((role) =>
      fileURLToPath(new URL(`./worker-exchange-${role}-process.ts`, import.meta.url)),
    ),
    bundle: true,
    platform: 'node',
    format: 'esm',
    splitting: true,
    outExtension: { '.js': '.mjs' },
    outdir,
    plugins: [externalProcessDependencies],
  });
}
