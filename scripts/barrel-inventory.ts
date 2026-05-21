#!/usr/bin/env tsx
/**
 * Barrel file inventory, generation, and dead-export analysis tool.
 *
 * Modes:
 * - **Inventory** (default): print a symbol table for a barrel file.
 * - **Generate** (`--generate`): emit replacement barrel content to stdout,
 *   optionally filtering dead exports when combined with `--cross-check`.
 * - **Cross-check** (`--cross-check`): scan all external consumers via the
 *   TS Compiler API to find symbols not imported anywhere outside the package.
 * - **Audit package** (`--audit-package`): scan all entry points of a package
 *   for dead symbols and dead source files.
 * @example
 * ```bash
 * # Inventory mode: print symbol table
 * tsx scripts/barrel-inventory.ts core/contracts/src/index.ts
 *
 * # Generate mode: emit replacement barrel (dead exports removed)
 * tsx scripts/barrel-inventory.ts --generate --cross-check core/contracts/src/index.ts
 *
 * # Audit all entry points of a package
 * tsx scripts/barrel-inventory.ts --audit-package core/contracts
 * ```
 */

import * as path from 'path';
import * as fs from 'fs';

import type { DeadExportSet } from './barrel-inventory/types.js';
import { findPackageDir } from './barrel-inventory/ts-program.js';
import { buildInventory, invertToDeadSet, isDeadExport } from './barrel-inventory/inventory.js';
import { findExternalConsumers } from './barrel-inventory/cross-check.js';
import { generateBarrel, printInventory } from './barrel-inventory/output.js';
import { auditPackage, printAuditReport } from './barrel-inventory/audit.js';

/**
 *
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const generateMode = args.includes('--generate');
  const useCrossCheck = args.includes('--cross-check');
  const auditPackageMode = args.includes('--audit-package');
  const positionalArg = args.find((a) => !a.startsWith('--'));

  if (!positionalArg) {
    console.error('Usage: barrel-inventory [--generate [--cross-check]] <barrel-file>');
    console.error('       barrel-inventory --audit-package <package-dir-or-file>');
    console.error('  --generate       Emit replacement barrel content to stdout');
    console.error('  --cross-check    Use TS Compiler API to find externally consumed symbols');
    console.error('  --audit-package  Scan ALL entry points of a package for dead symbols and dead files');
    process.exit(1);
  }

  const resolvedArg = path.resolve(process.cwd(), positionalArg);
  if (!fs.existsSync(resolvedArg)) {
    console.error(`Path not found: ${resolvedArg}`);
    process.exit(1);
  }

  if (auditPackageMode) {
    const packageDir = fs.statSync(resolvedArg).isDirectory() ? resolvedArg : findPackageDir(resolvedArg);
    const result = await auditPackage(packageDir);
    printAuditReport(result);
    return;
  }

  const barrelAbsPath = resolvedArg;

  console.error('Loading TypeScript program...');
  const inventory = buildInventory(barrelAbsPath);

  let dead: DeadExportSet | undefined;
  if (useCrossCheck) {
    const externallyUsed = await findExternalConsumers(barrelAbsPath);
    dead = invertToDeadSet(inventory, externallyUsed.values);
  }

  if (generateMode) {
    const content = generateBarrel(inventory, dead);
    process.stdout.write(content);

    let total = 0;
    for (const entries of inventory.groups.values()) total += entries.length;
    const deadCount = dead ? [...inventory.groups.values()].flat().filter((e) => isDeadExport(e, dead!)).length : 0;
    console.error(
      `\nGenerated barrel with ${total - deadCount} symbols (${deadCount} dead removed) from ${inventory.groups.size} sources`,
    );
    if (inventory.duplicates.size > 0) {
      console.error(`Resolved ${inventory.duplicates.size} cross-source duplicates (first-source wins)`);
    }
  } else {
    printInventory(inventory, dead);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
