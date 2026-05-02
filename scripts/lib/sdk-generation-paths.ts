import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_LIB_DIR = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = resolve(SCRIPTS_LIB_DIR, '..', '..');

/** Absolute path to the committed protocol manifest artifact. */
export const SDK_PROTOCOL_MANIFEST_PATH = resolve(FRAMEWORK_ROOT, 'sdks/manifest/makaio-bus-protocol.json');

/** Absolute path to generated Python subject constants. */
export const PYTHON_SUBJECTS_PATH = resolve(FRAMEWORK_ROOT, 'sdks/python/src/makaio/generated/subjects.py');

/** Absolute path to generated Rust subject constants and models. */
export const RUST_SUBJECTS_PATH = resolve(FRAMEWORK_ROOT, 'sdks/rust/src/generated/subjects.rs');
