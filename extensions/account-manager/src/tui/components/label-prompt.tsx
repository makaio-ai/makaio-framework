import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

/** Terminal rows occupied by {@link LabelPrompt}. */
export const LABEL_PROMPT_HEIGHT = 2;

/** Props for LabelPrompt */
interface LabelPromptProps {
  /** Called when the user submits a label */
  onSubmit: (label: string) => void;
  /** Called when the user cancels (Escape or empty Enter) */
  onCancel: () => void;
}

/**
 * Inline text input for labeling an account.
 *
 * Handles keyboard input directly via Ink's `useInput` hook since
 * `ink-text-input` is not available in this workspace.
 * @param props - Component props
 */
export function LabelPrompt({ onSubmit, onCancel }: LabelPromptProps): React.ReactElement {
  const [value, setValue] = useState('');

  useInput((input, key) => {
    if (key.return) {
      if (value.trim()) {
        onSubmit(value.trim());
      } else {
        onCancel();
      }
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setValue((v) => v + input);
    }
  });

  return (
    <Box marginTop={1}>
      <Text>Enter a label: </Text>
      <Text>{value}</Text>
      <Text dimColor>█</Text>
    </Box>
  );
}
