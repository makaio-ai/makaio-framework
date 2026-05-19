import type { FileValidationResults, ValidationSummary, ToolRunStatus } from '../types.js';

/**
 * Creates a validation summary from file results.
 *
 * Aggregates file-level validation results and tool statuses into a comprehensive
 * summary object, categorizing files by their fixability and generating suggested
 * actions for the AI agent.
 * @param fileResults - File validation results keyed by file path
 * @param toolStatuses - Tool execution statuses (ok/skipped/failed)
 * @param totalFilesCount - Total number of files validated
 * @returns Validation summary with stats and suggested actions
 */
export function createSummary(
  fileResults: FileValidationResults,
  toolStatuses: ToolRunStatus[],
  totalFilesCount: number,
): ValidationSummary {
  const filesWithErrors = Object.keys(fileResults).filter((file) =>
    fileResults[file].some((r) => !r.fixedAutomatically),
  );

  const fixableFiles = Object.keys(fileResults).filter((file) =>
    fileResults[file].some((r) => r.fixable && !r.fixedAutomatically),
  );

  const unfixableFiles = Object.keys(fileResults).filter((file) =>
    fileResults[file].some((r) => !r.fixable && r.severity === 'error'),
  );

  // Generate suggested actions for AI
  const suggestedActions = generateSuggestedActions(fileResults);

  return {
    fileResults,
    processedFiles: undefined, // set by caller if needed
    totalFiles: totalFilesCount,
    filesWithErrors: filesWithErrors.length,
    fixableFiles,
    unfixableFiles,
    suggestedActions,
    toolStatuses,
  };
}

/**
 * Generates suggested actions for AI based on validation results.
 *
 * Analyzes validation results to determine which files need biome/eslint/stylelint
 * auto-fixing or manual TypeScript fixes, generating actionable recommendations.
 * @param fileResults - File validation results keyed by file path
 * @returns Array of suggested actions with file paths and descriptions
 */
export function generateSuggestedActions(fileResults: FileValidationResults): ValidationSummary['suggestedActions'] {
  const actions: ValidationSummary['suggestedActions'] = [];

  for (const [file, results] of Object.entries(fileResults)) {
    const hasUnfixedPrettier = results.some((r) => r.tool === 'prettier' && r.fixable && !r.fixedAutomatically);
    const hasUnfixedBiome = results.some((r) => r.tool === 'biome' && r.fixable && !r.fixedAutomatically);
    const hasUnfixedEslint = results.some((r) => r.tool === 'eslint' && r.fixable && !r.fixedAutomatically);
    const hasStylelintErrors = results.some((r) => r.tool === 'stylelint' && r.severity === 'error');
    const hasTypeErrors = results.some((r) => r.tool === 'typescript' && r.severity === 'error');

    if (hasUnfixedBiome) {
      actions?.push({
        file,
        action: 'biome-fix',
        description: 'Run Biome formatting on this file',
      });
    }

    if (hasUnfixedPrettier) {
      actions?.push({
        file,
        action: 'prettier-fix',
        description: 'Run prettier --write on this file',
      });
    }

    if (hasUnfixedEslint) {
      actions?.push({
        file,
        action: 'eslint-fix',
        description: 'Run eslint --fix on this file',
      });
    }

    if (hasStylelintErrors) {
      actions?.push({
        file,
        action: 'stylelint-fix',
        description: 'Fix CSS/SCSS issues (token violations or undefined CSS variables)',
      });
    }

    if (hasTypeErrors) {
      actions?.push({
        file,
        action: 'manual-fix',
        description: 'Manual TypeScript fixes required',
      });
    }
  }

  return actions;
}
