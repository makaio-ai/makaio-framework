import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkflowError, WorkflowErrorCode } from '@makaio/contracts';
import { assertContainedIn } from './local-directory-materializer.js';
import type { RuntimeLoadedWorkflow } from './types.js';
import { loadWorkflowModules } from './workflow-file-loader.js';

/** The data the worker supervisor passes to the process without credentials. */
export interface CheckoutWorkflowSource {
  readonly checkoutRoot: string;
  /** Portable slash-separated path relative to the checkout. */
  readonly workflowPath: string;
  /** Logical workflow expected by the run. */
  readonly workflowId: string;
  /** Canonical file accepted by the host for a pinned source. */
  readonly verifiedPath?: string;
}

/** Frozen workflow source and the local roots prepared for its invocation. */
export interface CheckoutWorkflowBinding {
  readonly workflowId: string;
  /** Path projected by the host from the workflow definition's source. */
  readonly source: { readonly path: string };
  /** Reference to a prepared source root, independent of its position. */
  readonly sourceRootId: string;
  /** Immutable commit identifier from the Git source block. */
  readonly gitRevision?: string;
  readonly sourceRoots: readonly { readonly id: string; readonly path: string }[];
}

/**
 * Prepare the reader input before launching the process without credentials.
 * The caller verifies that the prepared root contains the selected revision.
 * @param binding - Frozen source fields and accepted local source roots.
 * @returns Reader input that preserves the projected workflow path.
 * @throws A workflow error when the revision or source-root binding is absent or ambiguous.
 */
export function bindCheckoutWorkflow(binding: CheckoutWorkflowBinding): CheckoutWorkflowSource {
  const { gitRevision, sourceRootId, sourceRoots, source, workflowId } = binding;
  if (gitRevision === undefined || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(gitRevision)) {
    throw new WorkflowError(WorkflowErrorCode.SOURCE_MISMATCH, 'Checkout workflow requires a fixed Git revision');
  }
  const [root, duplicate] = sourceRoots.filter(({ id }) => id === sourceRootId);
  if (root === undefined || duplicate !== undefined) {
    throw new WorkflowError(WorkflowErrorCode.SOURCE_MISMATCH, 'Checkout workflow requires a unique source root');
  }
  return { checkoutRoot: root.path, workflowPath: source.path, workflowId };
}

/**
 * Resolve a file against the bound checkout before the module loader sees it.
 * @param source - Checkout root and checkout-relative module path.
 * @param canonicalRoot - Require the provided root to already be canonical.
 * @returns Canonical path to an existing regular file.
 */
export async function resolveWorkflowPath(source: CheckoutWorkflowSource, canonicalRoot = false): Promise<string> {
  const { checkoutRoot, workflowPath, verifiedPath } = source;
  assertWorkflowPathSyntax(workflowPath);
  const root = await realpath(checkoutRoot);
  if ((canonicalRoot || verifiedPath !== undefined) && root !== checkoutRoot) {
    throw new WorkflowError(WorkflowErrorCode.SOURCE_MISMATCH, 'Checkout root changed after verification');
  }
  const file = await realpath(join(root, workflowPath));
  if (verifiedPath !== undefined && file !== verifiedPath) {
    throw new WorkflowError(WorkflowErrorCode.SOURCE_MISMATCH, 'Checkout workflow path changed after verification');
  }
  try {
    assertContainedIn(file, root, 'Workflow file');
  } catch {
    throw new WorkflowError(WorkflowErrorCode.SOURCE_MISMATCH, 'Workflow file resolves outside the checkout');
  }
  if (!(await stat(file)).isFile()) {
    throw new WorkflowError(WorkflowErrorCode.NOT_EXECUTABLE, 'Checkout workflow path is not a regular file');
  }
  return file;
}

/**
 * Require a portable path before beginning checkout preparation.
 * @param path - Admitted workflow path.
 */
export function assertWorkflowPathSyntax(path: string): void {
  if (
    typeof path !== 'string' ||
    /[:\\\0]/u.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new WorkflowError(WorkflowErrorCode.SOURCE_MISMATCH, 'Expected a checkout-relative workflow file path');
  }
}

/**
 * Load one workflow from a prepared checkout in a credential-free process.
 * The caller owns revision verification and keeps the checkout unchanged while loading.
 * Module evaluation runs in the current process, including top-level imports.
 * @param source - Bound checkout, relative module path and expected workflow identity.
 * @returns The validated definition and its runtime handlers.
 * @throws A workflow error when the path, module, or definition identity is invalid.
 */
export async function loadWorkflowFromCheckout(source: CheckoutWorkflowSource): Promise<RuntimeLoadedWorkflow> {
  let workflows: RuntimeLoadedWorkflow[];
  try {
    const path = await resolveWorkflowPath(source);
    workflows = await loadWorkflowModules({ kind: 'path', path });
  } catch (error) {
    if (
      error instanceof WorkflowError &&
      (error.code === WorkflowErrorCode.SOURCE_MISMATCH || error.code === WorkflowErrorCode.LOOP_CHECK_MULTIPLE)
    )
      throw error;
    throw new WorkflowError(WorkflowErrorCode.NOT_EXECUTABLE, 'Could not load the workflow from the bound checkout');
  }
  const [match, duplicate] = workflows.filter(({ definition }) => definition.id === source.workflowId);
  if (match === undefined) {
    throw new WorkflowError(
      WorkflowErrorCode.SOURCE_MISMATCH,
      'Checkout workflow does not match the expected identity',
    );
  }
  if (duplicate !== undefined) {
    throw new WorkflowError(WorkflowErrorCode.SOURCE_MISMATCH, 'Checkout workflow identity is ambiguous');
  }
  return match;
}
