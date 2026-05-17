#!/usr/bin/env tsx
/**
 * Build every publishable framework package outside the umbrella framework
 * package.
 *
 * The umbrella package has its own assembled distribution build. Descriptor
 * packages, providers, clients, and extensions are independent workspaces whose
 * npm tarballs must include their own `dist/` outputs before packlist
 * validation runs.
 * @packageDocumentation
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { stagePackageForNpmPublish } from './lib/npm-publish-staging.js';
import { findPublicPackageDirs, readPackageJson } from './lib/public-package-discovery.js';

const FRAMEWORK_ROOT = join(import.meta.dirname, '..');

const packages = findPublicPackageDirs(FRAMEWORK_ROOT)
  .map((dir) => ({ dir, pkg: readPackageJson(dir) }))
  .sort((a, b) => (a.pkg.name ?? a.dir).localeCompare(b.pkg.name ?? b.dir));
const frameworkVersion = readPackageJson(FRAMEWORK_ROOT).version;

if (!frameworkVersion) {
  throw new Error('Framework package is missing package version');
}

for (const { dir, pkg } of packages) {
  if (!pkg.name) {
    throw new Error(`Publishable package is missing package name: ${dir}`);
  }
  if (!pkg.scripts?.build) {
    throw new Error(`Publishable package is missing build script: ${pkg.name}`);
  }

  console.info(`[build-public] ${pkg.name}`);
  execFileSync('yarn', ['workspace', pkg.name, 'build'], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });

  const publishDir = stagePackageForNpmPublish(dir, frameworkVersion);
  console.info(`[build-public] staged ${pkg.name} at ${publishDir}`);
}
