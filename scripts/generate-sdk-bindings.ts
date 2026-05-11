import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import '@makaio/contracts';
import { format, resolveConfig } from 'prettier';
import { PublicProtocolNamespaces } from '../packages/contracts/src/protocol/catalog.js';
import { exportProtocolManifest, formatProtocolManifest } from '../packages/contracts/src/protocol/index.js';
import { writePythonNamespaceModules, writePythonSubjects } from './bindings/python.js';
import { writePythonPayloads } from './bindings/python-payloads.js';
import { writeRustSubjects } from './bindings/rust.js';
import { SDK_PROTOCOL_MANIFEST_PATH } from './lib/sdk-generation-paths.js';

// 1. Generate the protocol manifest
const manifest = exportProtocolManifest({ catalog: PublicProtocolNamespaces });
const prettierConfig = (await resolveConfig(SDK_PROTOCOL_MANIFEST_PATH)) ?? {};
const formattedManifest = await format(formatProtocolManifest(manifest), { ...prettierConfig, parser: 'json' });
await mkdir(dirname(SDK_PROTOCOL_MANIFEST_PATH), { recursive: true });
await writeFile(SDK_PROTOCOL_MANIFEST_PATH, formattedManifest, 'utf8');
console.info(`Generated: ${SDK_PROTOCOL_MANIFEST_PATH}`);

// 2. Generate Python subject bindings (flat SCREAMING_SNAKE_CASE constants)
const pythonPath = await writePythonSubjects(manifest);
console.info(`Generated: ${pythonPath}`);

// 3. Generate Python payload dataclass modules
const payloadPaths = await writePythonPayloads(manifest);
for (const p of payloadPaths) {
  console.info(`Generated: ${p}`);
}

// 4. Generate Python namespace modules (typed EventSubject / RequestSubject instances)
const namespacePaths = await writePythonNamespaceModules(manifest);
for (const p of namespacePaths) {
  console.info(`Generated: ${p}`);
}

// 5. Generate Rust subject bindings (preserving hand-authored structs)
const rustPath = await writeRustSubjects(manifest);
console.info(`Generated: ${rustPath}`);
