import { defineDialectSchema } from '@makaio/storage-drizzle';
import {
  workflowDefinitions,
  workflowExecutions,
  workflowExecutionFrames,
  workflowGateInstances,
  workflowStepSpans,
  workflowExecutionLinks,
  workflowRunContexts,
  worklogSummaries,
  worklogFrameEntries,
  worklogArtifactWrites,
  worklogGateEvents,
} from './schema.js';
import {
  workflowDefinitions as workflowDefinitionsPg,
  workflowExecutions as workflowExecutionsPg,
  workflowExecutionFrames as workflowExecutionFramesPg,
  workflowGateInstances as workflowGateInstancesPg,
  workflowStepSpans as workflowStepSpansPg,
  workflowExecutionLinks as workflowExecutionLinksPg,
  workflowRunContexts as workflowRunContextsPg,
  worklogSummaries as worklogSummariesPg,
  worklogFrameEntries as worklogFrameEntriesPg,
  worklogArtifactWrites as worklogArtifactWritesPg,
  worklogGateEvents as worklogGateEventsPg,
} from './schema.postgres.js';

/** Dialect variants for the workflow engine storage tables. */
export const workflowEngineSchema = defineDialectSchema(
  {
    workflowDefinitions,
    workflowExecutions,
    workflowExecutionFrames,
    workflowGateInstances,
    workflowStepSpans,
    workflowExecutionLinks,
    workflowRunContexts,
    worklogSummaries,
    worklogFrameEntries,
    worklogArtifactWrites,
    worklogGateEvents,
  },
  {
    workflowDefinitions: workflowDefinitionsPg,
    workflowExecutions: workflowExecutionsPg,
    workflowExecutionFrames: workflowExecutionFramesPg,
    workflowGateInstances: workflowGateInstancesPg,
    workflowStepSpans: workflowStepSpansPg,
    workflowExecutionLinks: workflowExecutionLinksPg,
    workflowRunContexts: workflowRunContextsPg,
    worklogSummaries: worklogSummariesPg,
    worklogFrameEntries: worklogFrameEntriesPg,
    worklogArtifactWrites: worklogArtifactWritesPg,
    worklogGateEvents: worklogGateEventsPg,
  },
);
