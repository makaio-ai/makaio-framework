import * as path from 'path';

import type { BarrelInventory, DeadExportSet } from './types.js';
import { isDeadExport } from './inventory.js';

/**
 * Prints the barrel inventory as a human-readable table to stdout.
 * @param inv - The barrel inventory.
 * @param dead - Optional dead-export set to annotate dead symbols.
 */
export function printInventory(inv: BarrelInventory, dead?: DeadExportSet): void {
  let totalSymbols = 0;
  let valueCount = 0;
  let typeCount = 0;
  let bothCount = 0;
  let deadCount = 0;

  console.log(`\nBarrel: ${path.relative(process.cwd(), inv.barrelPath)}\n`);

  for (const [specifier, entries] of inv.groups) {
    console.log(`  ${specifier} (${entries.length} symbols)`);
    for (const entry of entries) {
      const marker = entry.kind === 'value' ? 'V' : entry.kind === 'type' ? 'T' : 'B';
      const dupWarning = (inv.duplicates.get(entry.name)?.length ?? 0) > 1 ? ' ⚠ DUP' : '';
      const isDead = dead && isDeadExport(entry, dead);
      const deadMarker = isDead ? ' ✗ DEAD' : '';
      console.log(`    [${marker}] ${entry.name}${dupWarning}${deadMarker}`);
      totalSymbols++;
      if (isDead) deadCount++;
      if (entry.kind === 'value') valueCount++;
      else if (entry.kind === 'type') typeCount++;
      else bothCount++;
    }
    console.log();
  }

  console.log(`Total: ${totalSymbols} symbols (${valueCount} value, ${typeCount} type, ${bothCount} both)`);
  if (dead) {
    console.log(`Dead: ${deadCount} symbols can be removed`);
  }

  if (inv.duplicates.size > 0) {
    console.log(`\n⚠ Duplicates (${inv.duplicates.size}):`);
    for (const [name, sources] of inv.duplicates) {
      console.log(`  ${name}: ${sources.join(', ')}`);
    }
  }
}

/**
 * Generates replacement barrel content as a string.
 * @param inv - The barrel inventory.
 * @param dead - Optional dead-export set to filter out dead symbols.
 */
export function generateBarrel(inv: BarrelInventory, dead?: DeadExportSet): string {
  const lines: string[] = [];
  const emitted = new Set<string>();

  for (const [specifier, entries] of inv.groups) {
    const valueExports: string[] = [];
    const typeExports: string[] = [];

    for (const entry of entries) {
      if (emitted.has(entry.name)) continue;
      if (dead && isDeadExport(entry, dead)) continue;

      emitted.add(entry.name);
      const exportName = formatExportName(entry);

      if (entry.kind === 'type') {
        typeExports.push(exportName);
      } else {
        valueExports.push(exportName);
      }
    }

    if (valueExports.length === 0 && typeExports.length === 0) continue;

    if (valueExports.length > 0) {
      lines.push(formatExportStatement(valueExports, specifier, false));
    }
    if (typeExports.length > 0) {
      lines.push(formatExportStatement(typeExports, specifier, true));
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Formats a symbol for named export syntax, preserving source aliases.
 * @param entry - Export entry to format.
 */
function formatExportName(entry: { name: string; sourceName?: string }): string {
  return entry.sourceName && entry.sourceName !== entry.name ? `${entry.sourceName} as ${entry.name}` : entry.name;
}

/**
 * Formats a single export statement with the given symbol names.
 * Uses single-line format for ≤3 names, multi-line otherwise.
 * @param names - The symbol names to export.
 * @param specifier - The module specifier.
 * @param isTypeOnly - Whether this is a type-only export.
 */
export function formatExportStatement(names: string[], specifier: string, isTypeOnly: boolean): string {
  const keyword = isTypeOnly ? 'export type' : 'export';
  const specifierLiteral = `'${specifier}'`;

  if (names.length <= 3) {
    return `${keyword} { ${names.join(', ')} } from ${specifierLiteral};`;
  }

  const nameLines = names.map((n) => `  ${n},`).join('\n');
  return `${keyword} {\n${nameLines}\n} from ${specifierLiteral};`;
}
