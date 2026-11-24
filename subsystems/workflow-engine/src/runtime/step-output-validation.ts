import Ajv, { type ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  walkWorkflowDefinition,
  WorkflowAgentStepNodeSchema,
  WorkflowCodeStepNodeSchema,
  WorkflowError,
  WorkflowErrorCode,
  type JsonValue,
  type WorkflowAgentStepNode,
  type WorkflowCodeStepNode,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@makaio/contracts';

type WorkflowStep = WorkflowAgentStepNode | WorkflowCodeStepNode;

// Preflight and repeated dispatch can share the validator for a declared schema.
const validators = new WeakMap<WorkflowNode, ValidateFunction>();

/**
 * Compile all declared output schemas before starting the workflow.
 * @param definition - Resolved workflow definition.
 * @param admit - Optional runner-specific check of each executable step.
 */
export function preflightStepOutputs(definition: WorkflowDefinition, admit?: (step: WorkflowStep) => void): void {
  walkWorkflowDefinition(definition.root, {
    enter(node) {
      if (node.type !== 'agent-step' && node.type !== 'code-step') return;
      const step =
        node.type === 'agent-step' ? WorkflowAgentStepNodeSchema.parse(node) : WorkflowCodeStepNodeSchema.parse(node);
      admit?.(step);
      resolveStepOutputValidator(step, node);
    },
  });
}

/**
 * Select the compiler for the declared JSON Schema dialect.
 * @param uri - Value of the schema's `$schema` property.
 * @returns A compiler for that dialect, or AJV's draft-07 compiler for the default.
 */
function createSchemaCompiler(uri: JsonValue | undefined) {
  const dialect = typeof uri === 'string' ? uri.replace(/#$/, '') : uri;
  const options = { strict: false };
  switch (dialect) {
    case 'https://json-schema.org/draft/2019-09/schema':
      return new Ajv2019(options);
    case 'https://json-schema.org/draft/2020-12/schema':
      return new Ajv2020(options);
    case undefined:
    case 'http://json-schema.org/draft-07/schema':
      return new Ajv(options);
    default:
      throw new Error('Unsupported JSON Schema dialect');
  }
}

/**
 * Compile a declared step output schema without exposing compiler diagnostics.
 * @param step - Authored step and its optional output contract.
 * @param node - Original workflow node when preflight has parsed a copy of it.
 * @returns The synchronous validator, when the step declares a schema.
 */
export function resolveStepOutputValidator(
  step: WorkflowStep,
  node: WorkflowNode = step,
): ValidateFunction | undefined {
  const { outputSchema } = step;
  if (outputSchema === undefined) return undefined;
  const cached = validators.get(node);
  if (cached !== undefined) return cached;
  try {
    const validate = createSchemaCompiler(outputSchema['$schema']).compile(outputSchema);
    if (!('$async' in validate)) {
      validators.set(node, validate);
      return validate;
    }
  } catch {
    // Compiler diagnostics may contain authored data.
  }
  throw new WorkflowError(
    WorkflowErrorCode.STEP_OUTPUT_SCHEMA_INVALID,
    `Step '${step.id}' has an invalid or unsupported output schema`,
  );
}
