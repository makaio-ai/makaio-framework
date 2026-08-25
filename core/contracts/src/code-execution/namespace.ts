import { createBusNamespace } from '@makaio/core';
import { CodeExecutionSchemas } from './schemas.js';

/**
 * CodeExecution bus namespace.
 *
 * Registers the `code-execution` namespace with the framework's execution
 * routing subject. Part of `FrameworkContractNamespaces`, so hosts can
 * validate and route the subject even when they compose no handler.
 * Use {@link CodeExecutionSubjects} to access typed bus subject descriptors.
 */
export const CodeExecutionNamespace = createBusNamespace('code-execution', CodeExecutionSchemas);

/**
 * Typed subjects for CodeExecution bus communication.
 *
 * Available subjects:
 * - `CodeExecutionSubjects.execute` — execute one prepared invocation (RPC)
 */
export const CodeExecutionSubjects = CodeExecutionNamespace.subjects;
