import { pathToFileURL } from 'node:url';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { WorkflowDefinitionSchema, type WorkflowWorkerSource, type WorkflowZodSchemas } from '@makaio/contracts';
import type { RuntimeLoadedWorkflow } from './types.js';

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

/**
 * Validate that a value matches the {@link RuntimeLoadedWorkflow} shape.
 *
 * Guards against incorrectly structured default exports — anything that
 * looks like a `defineWorkflow()` result (has a `definition` object and a
 * `runtimeHandlers` Map) passes.
 * @param value - Candidate value from the module's default export.
 * @returns The value narrowed to {@link RuntimeLoadedWorkflow}.
 * @throws When the value does not match the expected shape.
 */
function normalizeWorkflowDefaultExport(value: unknown): RuntimeLoadedWorkflow {
  if (typeof value !== 'object' || value === null) {
    throw new Error(
      `Invalid workflow module default export: expected an object with 'definition' and 'runtimeHandlers', got ${typeof value}.`,
    );
  }

  const obj = value as Record<string, unknown>;

  if (!(obj['runtimeHandlers'] instanceof Map)) {
    throw new Error(`Invalid workflow module default export: 'runtimeHandlers' must be a Map instance.`);
  }

  // Workflow files export defineWorkflow() builders, whose definition is the
  // persisted pipeline-primitive definition contract.
  const definitionResult = WorkflowDefinitionSchema.safeParse(obj['definition']);
  if (!definitionResult.success) {
    throw new Error(
      `Invalid workflow module default export: 'definition' must satisfy WorkflowDefinitionSchema. ` +
        definitionResult.error.message,
    );
  }

  const zodSchemas = isWorkflowZodSchemas(obj['zodSchemas']) ? obj['zodSchemas'] : undefined;

  return {
    definition: definitionResult.data as RuntimeLoadedWorkflow['definition'],
    runtimeHandlers: obj['runtimeHandlers'] as RuntimeLoadedWorkflow['runtimeHandlers'],
    ...(zodSchemas !== undefined ? { zodSchemas } : {}),
  };
}

/**
 * Check whether a module export carries the workflow builder schema container.
 * @param value - Candidate `zodSchemas` export value.
 * @returns Whether the value has the builder schema container shape.
 */
function isWorkflowZodSchemas(value: unknown): value is WorkflowZodSchemas {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'gates' in value;
}

/**
 * Write inline workflow source code to a temporary `.mjs` file.
 *
 * Creates an isolated temp directory per invocation so concurrent calls
 * never collide. The caller is responsible for cleaning up via the returned
 * `tempDir` after the module has been imported.
 *
 * Sanitizes `filename` using `basename()` to prevent path traversal attacks.
 * @param filename - Virtual filename hint (used for the temp file basename).
 * @param source - ESM source code to write.
 * @returns Object containing the `tempDir` and the absolute `tempPath` of the written file.
 * @throws When `filename` resolves to an empty or invalid basename.
 */
async function writeWorkflowSourceToTempFile(
  filename: string,
  source: string,
): Promise<{ tempDir: string; tempPath: string }> {
  const sanitized = basename(filename);
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error(`Invalid workflow source filename: ${filename}`);
  }
  const tempDir = join(tmpdir(), `makaio-wf-${randomBytes(6).toString('hex')}`);
  await mkdir(tempDir, { recursive: true });
  const tempBasename = sanitized.endsWith('.mjs') ? sanitized : `${sanitized}.mjs`;
  const tempPath = join(tempDir, tempBasename);
  try {
    await writeFile(tempPath, source, 'utf8');
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { tempDir, tempPath };
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Load a workflow module from the given source descriptor.
 *
 * Supports two source kinds:
 * - `'path'`: dynamically imports the file at `source.path` via a `file://` URL.
 * - `'source'`: writes inline ESM code to a temp file, imports it, then
 *   removes the temp directory.
 *
 * `'definition'`-sourced workers bypass the file loader entirely — they are
 * handled by the workflow executor which has access to the registered
 * definition registry. Calling this function with `kind === 'definition'`
 * always throws.
 * @param source - Workflow source descriptor from `WorkflowWorkerConfig.source`.
 * @returns Loaded workflow with `definition` and `runtimeHandlers`.
 * @throws For `'definition'` kind or when the module shape is invalid.
 */
export async function loadWorkflowModule(source: WorkflowWorkerSource): Promise<RuntimeLoadedWorkflow> {
  if (source.kind === 'path') {
    const mod = (await import(/* @vite-ignore */ pathToFileURL(source.path).href)) as { default?: unknown };
    return normalizeWorkflowDefaultExport(mod.default);
  }

  if (source.kind === 'source') {
    const { tempDir, tempPath } = await writeWorkflowSourceToTempFile(source.filename, source.source);
    try {
      const mod = (await import(/* @vite-ignore */ pathToFileURL(tempPath).href)) as { default?: unknown };
      return normalizeWorkflowDefaultExport(mod.default);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  // source.kind === 'definition'
  throw new Error(
    `Definition-sourced workers are handled by the workflow executor, not the file loader. ` +
      `Received source: ${JSON.stringify(source)}`,
  );
}
