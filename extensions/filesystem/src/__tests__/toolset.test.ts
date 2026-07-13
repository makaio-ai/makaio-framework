import { describe, expect, it } from 'vitest';
import { readOnlyFilesystemToolset } from '../index.js';
import { readOnlyFilesystemToolset as serverReadOnlyFilesystemToolset } from '../server.js';

describe('readOnlyFilesystemToolset', () => {
  it('is exported from the server entrypoint', () => {
    expect(serverReadOnlyFilesystemToolset).toBe(readOnlyFilesystemToolset);
  });

  it('exports exactly the read-only filesystem tools', () => {
    const toolNames = Object.keys(readOnlyFilesystemToolset.tools).sort();

    expect(toolNames).toEqual(['glob_files', 'grep_files', 'list_directory', 'read_file']);
    expect(toolNames).not.toContain('write_file');
    expect(toolNames).not.toContain('edit_file');
    expect(toolNames).not.toContain('delete_file');
  });
});
