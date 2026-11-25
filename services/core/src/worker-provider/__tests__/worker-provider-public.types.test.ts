import { resolve } from 'node:path';
import type { WorkerDispatchCapability } from '@makaio/contracts/capabilities';
import type * as WorkerProvider from '@makaio/services-core/worker-provider';
import ts from 'typescript';
import { expect, expectTypeOf, it } from 'vitest';

const publicSubpath = '@makaio/framework/services/worker-provider';
const internalSubpath = '@makaio/framework/services/internal/worker-provider-host-binding';
const publicPackage = resolve(import.meta.dirname, '../../../../../packages/framework');
const sources = new Map([
  [resolve(publicPackage, 'dist/services/worker-provider/index.d.mts'), resolve(import.meta.dirname, '../index.ts')],
  [
    resolve(publicPackage, 'dist/services/internal/worker-provider-host-binding.d.mts'),
    resolve(import.meta.dirname, '../../internal/worker-provider-host-binding.ts'),
  ],
]);
const consumer = resolve(publicPackage, 'worker-provider-consumer.mts');
const imports = `
  import type { WorkerDispatchCapability, WorkerStartOptions, WorkerProviderRegistry } from '${publicSubpath}';
  import { createWorkerDispatch } from '${publicSubpath}';
  import { WorkerProviderRegistry as HostRegistry, createWorkerDispatch as hostDispatch } from '${internalSubpath}';
  import type { WorkerStartOptions as LegacyOptions } from '${publicSubpath}/host-binding';
  export { HostRegistry, hostDispatch };
  export type DispatchContract = WorkerDispatchCapability;
`;

it('exposes the host dispatch contract without composition controls', () => {
  expectTypeOf<WorkerProvider.WorkerDispatchCapability>().toEqualTypeOf<WorkerDispatchCapability>();
  expectTypeOf<keyof typeof WorkerProvider>().toEqualTypeOf<never>();

  const options: ts.CompilerOptions = { module: ts.ModuleKind.NodeNext, noResolve: true, noLib: true, types: [] };
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (file) => sources.has(file) || fileExists(file);
  const virtualConsumer = ts.createSourceFile(consumer, imports, ts.ScriptTarget.ESNext);
  host.getSourceFile = (file, ...args) => (file === consumer ? virtualConsumer : readSource(file, ...args));
  // Use the export map in either case and supply the source entries before a build.
  host.resolveModuleNames = (names, from) =>
    names.map((name) => {
      const entry = ts.resolveModuleName(name, from, options, host).resolvedModule;
      const source = entry && !fileExists(entry.resolvedFileName) ? sources.get(entry.resolvedFileName) : undefined;
      return entry && source ? { ...entry, resolvedFileName: source, extension: ts.Extension.Ts } : entry;
    });

  const entries = [...sources].map(([declaration, source]) => (fileExists(declaration) ? declaration : source));
  const program = ts.createProgram([consumer, ...entries], options, host);
  const diagnostics = program
    .getSemanticDiagnostics(virtualConsumer)
    .map(({ code, messageText }) => ({ code, message: ts.flattenDiagnosticMessageText(messageText, '\n') }));
  expect(diagnostics).toEqual([
    { code: 2305, message: expect.stringMatching(/has no exported member 'WorkerStartOptions'\.$/) },
    { code: 2305, message: expect.stringMatching(/has no exported member 'WorkerProviderRegistry'\.$/) },
    { code: 2305, message: expect.stringMatching(/has no exported member 'createWorkerDispatch'\.$/) },
    { code: 2307, message: expect.stringContaining(`Cannot find module '${publicSubpath}/host-binding'`) },
  ]);
});
