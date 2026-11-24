import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('typechecks the Code Step contract without Node declarations', () => {
  const entry = fileURLToPath(new URL('../code-step-context.ts', import.meta.url));
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: [],
    strict: true,
    noEmit: true,
  });

  const contract = program.getSourceFile(entry);
  if (contract === undefined) throw new Error('The Code Step contract was not loaded');
  const diagnostics = program.getSemanticDiagnostics(contract);
  expect(diagnostics.map(({ messageText }) => ts.flattenDiagnosticMessageText(messageText, '\n'))).toEqual([]);
});
