export {
  resolvePath,
  createPathValidator,
  validatePath,
  resolveAndValidatePath,
  getFileName,
  getParentDir,
  type PathValidationResult,
  type PathValidator,
} from './path-utils.js';

export { isHiddenName, getPathSeparator, normalizePlatformPath } from './platform.js';
export { getFileAccessRules } from './file-access-rules.js';
export { handleFsError } from './fs-errors.js';
export { validateRelativeGlobPattern } from './glob-patterns.js';
