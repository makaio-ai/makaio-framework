import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { loadWorkflowModule } from '../workflow-file-loader.js';

/**
 * Create an isolated temp directory for each test.
 * @returns Absolute path to the created temp directory.
 */
function makeTempDir(): string {
  return join(tmpdir(), `wf-loader-${randomBytes(6).toString('hex')}`);
}

/** Directories to clean up after each test. */
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Build a serializable workflow module content string that creates a
 * workflow-builder-shaped default export without requiring workspace imports.
 *
 * The shape mirrors the output of `defineWorkflow()`: an object with
 * `definition` (WorkflowDefinitionInput) and `runtimeSteps` (`Map<string, fn>`).
 * @param id - Workflow identifier.
 * @param stepIds - Step IDs to register in the runtime map.
 * @returns ESM module source string.
 */
function makeWorkflowModuleSource(id: string, stepIds: string[]): string {
  const stepEntries = stepIds.map((sid) => `['${sid}', (ctx) => ctx]`).join(', ');
  return `
const definition = {
  id: '${id}',
  name: '${id}',
  steps: [${stepIds.map((sid) => `{ id: '${sid}', type: 'function', runtime: true }`).join(', ')}],
  triggers: [],
  scope: { type: 'global' },
};
const runtimeSteps = new Map([${stepEntries}]);
export default { definition, runtimeSteps };
`;
}

describe('loadWorkflowModule', () => {
  describe('kind: path', () => {
    it('loads a .mjs workflow module and returns definition + runtimeSteps', async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      await mkdir(dir, { recursive: true });

      const content = makeWorkflowModuleSource('file-loader-test', ['step1']);
      const filePath = join(dir, 'test-workflow.mjs');
      await writeFile(filePath, content, 'utf8');

      const loaded = await loadWorkflowModule({ kind: 'path', path: filePath });

      expect(loaded.definition.id).toBe('file-loader-test');
      expect(loaded.definition.name).toBe('file-loader-test');
      expect(loaded.runtimeSteps.size).toBe(1);
      expect(loaded.runtimeSteps.has('step1')).toBe(true);
      expect(loaded.runtimeSteps.get('step1')).toBeTypeOf('function');
    });

    it('returns all registered step functions from a multi-step workflow', async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      await mkdir(dir, { recursive: true });

      const content = makeWorkflowModuleSource('multi-step', ['fetch', 'process', 'output']);
      const filePath = join(dir, 'multi-step.mjs');
      await writeFile(filePath, content, 'utf8');

      const loaded = await loadWorkflowModule({ kind: 'path', path: filePath });

      expect(loaded.runtimeSteps.size).toBe(3);
      expect(loaded.runtimeSteps.has('fetch')).toBe(true);
      expect(loaded.runtimeSteps.has('process')).toBe(true);
      expect(loaded.runtimeSteps.has('output')).toBe(true);
    });

    it('throws when the default export is missing definition and runtimeSteps', async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      await mkdir(dir, { recursive: true });

      const content = `export default { notAWorkflow: true };`;
      const filePath = join(dir, 'bad-workflow.mjs');
      await writeFile(filePath, content, 'utf8');

      await expect(loadWorkflowModule({ kind: 'path', path: filePath })).rejects.toThrow(/invalid workflow module/i);
    });

    it('throws when the module has no default export', async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      await mkdir(dir, { recursive: true });

      const content = `export const foo = 'bar';`;
      const filePath = join(dir, 'no-default.mjs');
      await writeFile(filePath, content, 'utf8');

      await expect(loadWorkflowModule({ kind: 'path', path: filePath })).rejects.toThrow(/invalid workflow module/i);
    });

    it('throws when runtimeSteps is not a Map', async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      await mkdir(dir, { recursive: true });

      // definition present but runtimeSteps is a plain object, not a Map
      const content = `
export default {
  definition: { id: 'x', name: 'x', steps: [], triggers: [], scope: { type: 'global' } },
  runtimeSteps: { step1: () => {} },
};
`;
      const filePath = join(dir, 'bad-steps.mjs');
      await writeFile(filePath, content, 'utf8');

      await expect(loadWorkflowModule({ kind: 'path', path: filePath })).rejects.toThrow(/invalid workflow module/i);
    });

    it('throws when the default export definition fails the workflow definition input schema', async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      await mkdir(dir, { recursive: true });

      const content = `
export default {
  definition: { id: 'invalid', name: 'invalid', steps: [{ id: 'bad', type: 'unknown' }], scope: { type: 'global' } },
  runtimeSteps: new Map(),
};
`;
      const filePath = join(dir, 'invalid-definition.mjs');
      await writeFile(filePath, content, 'utf8');

      await expect(loadWorkflowModule({ kind: 'path', path: filePath })).rejects.toThrow(/invalid workflow module/i);
    });
  });

  describe('kind: source', () => {
    it('loads an inline source workflow and returns definition + runtimeSteps', async () => {
      const source = makeWorkflowModuleSource('source-test', ['greet']);

      const loaded = await loadWorkflowModule({
        kind: 'source',
        filename: 'inline-test.mjs',
        source,
      });

      expect(loaded.definition.id).toBe('source-test');
      expect(loaded.runtimeSteps.size).toBe(1);
      expect(loaded.runtimeSteps.has('greet')).toBe(true);
    });

    it('imports inline source from an .mjs temp module even when the virtual filename is TypeScript', async () => {
      const source = `
const definition = {
  id: import.meta.url.endsWith('.mjs') ? 'mjs-temp-module' : 'wrong-extension',
  name: 'source-extension-test',
  steps: [],
  triggers: [],
  scope: { type: 'global' },
};
export default { definition, runtimeSteps: new Map() };
`;

      const loaded = await loadWorkflowModule({
        kind: 'source',
        filename: 'inline-source.ts',
        source,
      });

      expect(loaded.definition.id).toBe('mjs-temp-module');
    });

    it('loads an inline source workflow with multiple steps', async () => {
      const source = makeWorkflowModuleSource('source-multi', ['a', 'b']);

      const loaded = await loadWorkflowModule({
        kind: 'source',
        filename: 'inline-multi.mjs',
        source,
      });

      expect(loaded.definition.id).toBe('source-multi');
      expect(loaded.runtimeSteps.size).toBe(2);
    });

    it('throws for a filename that resolves to an empty basename after sanitization', async () => {
      const source = makeWorkflowModuleSource('traversal-test', []);

      await expect(
        loadWorkflowModule({
          kind: 'source',
          filename: '/',
          source,
        }),
      ).rejects.toThrow(/invalid workflow source filename/i);
    });

    it('sanitizes path traversal sequences in filename', async () => {
      const source = makeWorkflowModuleSource('traversal-safe', ['step1']);

      // '../evil.mjs' basename is 'evil.mjs' — should succeed and load correctly
      const loaded = await loadWorkflowModule({
        kind: 'source',
        filename: '../evil.mjs',
        source,
      });

      expect(loaded.definition.id).toBe('traversal-safe');
    });
  });

  describe('kind: definition', () => {
    it('throws because definition-sourced workers are handled by the workflow executor', async () => {
      await expect(loadWorkflowModule({ kind: 'definition', workflowId: 'some-id' })).rejects.toThrow(
        /definition-sourced/i,
      );
    });
  });
});
