import { AdapterResult, colors, formatDuration, ROOT } from './types.js';

/**
 * Prints the conformance test summary to console.
 * @param results - Array of adapter test results
 * @param startTime - Start timestamp for total duration
 * @param schemaViolationsPath - Path where full schema violation details are written
 */
// eslint-disable-next-line complexity -- Simple print function with formatting loops
export function printSummary(results: AdapterResult[], startTime: number, schemaViolationsPath: string): void {
  console.info('\n');
  console.info(`${colors.bold}CONFORMANCE TEST SUMMARY${colors.reset}`);
  console.info();

  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  const sorted = results.sort((a, b) => a.adapter.localeCompare(b.adapter));

  for (const r of sorted) {
    const passStr = r.passed > 0 ? `${colors.green}${r.passed} Pass${colors.reset}` : `0 Pass`;
    const failStr = r.failed > 0 ? `${colors.red}${r.failed} Fail${colors.reset}` : `0 Fail`;
    const skipStr = r.skipped > 0 ? `${colors.yellow}${r.skipped} Skip${colors.reset}` : `0 Skip`;
    console.info(`${r.adapter.padEnd(20)} | ${passStr} | ${failStr} | ${skipStr} | ${formatDuration(r.duration)}`);
    totalPassed += r.passed;
    totalFailed += r.failed;
    totalSkipped += r.skipped;
  }

  const withFailures = sorted.filter((r) => r.errors.length > 0);
  if (withFailures.length > 0) {
    console.info();
    console.info(`${colors.red}${colors.bold}Failures:${colors.reset}`);
    for (const r of withFailures) {
      for (const err of r.errors) {
        const relativePath = err.file?.replace(ROOT + '/', '') ?? '';
        const location = relativePath && err.line ? ` (${relativePath}:${err.line})` : '';
        console.info(`  ${colors.dim}[${r.adapter}]${colors.reset} ${err.test}: ${err.message}${location}`);
      }
    }
  }

  const withUnhandled = sorted.filter((r) => r.unhandledErrors.length > 0);
  if (withUnhandled.length > 0) {
    console.info();
    console.info(`${colors.red}${colors.bold}Unhandled Errors:${colors.reset}`);
    for (const r of withUnhandled) {
      for (const err of r.unhandledErrors) {
        const relativePath = err.file?.replace(ROOT + '/', '') ?? '';
        const location = relativePath ? ` (${relativePath}:${err.line})` : '';
        const name = err.name ? `${err.name}: ` : '';
        console.info(`  ${colors.dim}[${r.adapter}]${colors.reset} ${name}${err.message}${location}`);
      }
    }
  }

  const withViolations = sorted.filter((r) => r.schemaViolations.length > 0);
  if (withViolations.length > 0) {
    console.info();
    console.info(`${colors.yellow}${colors.bold}Schema Violations (non-fatal):${colors.reset}`);
    for (const r of withViolations) {
      console.info(`  ${colors.dim}[${r.adapter}]${colors.reset} ${r.schemaViolations.length} violation(s)`);
    }
    console.info(`  ${colors.dim}Full details written to ${schemaViolationsPath}${colors.reset}`);
  }

  console.info();
  const statusColor = totalFailed > 0 ? colors.red : colors.green;
  const skipText = totalSkipped > 0 ? `, ${totalSkipped} skipped` : '';
  console.info(
    `${statusColor}Total: ${totalPassed} passed, ${totalFailed} failed${skipText}${colors.reset} (${formatDuration(Date.now() - startTime)})`,
  );
  console.info();
}
