/**
 * Consent step component for the setup TUI.
 *
 * Displays the terms document with basic markdown formatting and waits for
 * the user to accept with `y`.
 * @packageDocumentation
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import type { SetupState } from '@makaio/setup';

/**
 * Props for the ConsentStep component.
 */
export interface ConsentStepProps {
  /** Current setup state. */
  readonly state: SetupState;
  /** Callback invoked when the user accepts the terms. */
  readonly onAccept: () => void;
}

/**
 * Renders a single line of markdown text with inline bold formatting.
 * @param text - Source markdown line.
 * @param dimColor - Whether the text should be dimmed.
 */
function MarkdownLine({ text, dimColor }: { text: string; dimColor?: boolean }): React.JSX.Element {
  const segments: React.JSX.Element[] = [];
  const boldRegex = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = boldRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push(
        <Text key={lastIndex} dimColor={dimColor}>
          {text.slice(lastIndex, match.index)}
        </Text>,
      );
    }
    segments.push(
      <Text key={match.index} bold dimColor={dimColor}>
        {match[1]}
      </Text>,
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push(
      <Text key={lastIndex} dimColor={dimColor}>
        {text.slice(lastIndex)}
      </Text>,
    );
  }

  return <>{segments}</>;
}

/**
 * Renders a markdown document as formatted Ink elements.
 *
 * Supports: `# heading`, `## heading`, `1. items`, `- items`, blank lines,
 * and inline `**bold**`.
 * @param content - The raw markdown content.
 */
function RenderedTerms({ content }: { content: string }): React.JSX.Element {
  const lines = content.split('\n');
  const elements: React.JSX.Element[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.trim() === '') {
      elements.push(<Text key={i}> </Text>);
      continue;
    }

    const h1Match = line.match(/^# (.+)$/);
    if (h1Match) {
      elements.push(
        <Text key={i} bold color="cyan">
          {h1Match[1]}
        </Text>,
      );
      continue;
    }

    const h2Match = line.match(/^## (.+)$/);
    if (h2Match) {
      elements.push(
        <Text key={i} bold>
          {h2Match[1]}
        </Text>,
      );
      continue;
    }

    const olMatch = line.match(/^(\d+)\.\s+(.+)$/);
    if (olMatch) {
      elements.push(
        <Box key={i} marginLeft={1}>
          <Text dimColor>{`${olMatch[1]}. `}</Text>
          <MarkdownLine text={olMatch[2]!} />
        </Box>,
      );
      continue;
    }

    const ulMatch = line.match(/^[-*]\s+(.+)$/);
    if (ulMatch) {
      elements.push(
        <Box key={i} marginLeft={1}>
          <Text dimColor>{'• '}</Text>
          <MarkdownLine text={ulMatch[1]!} />
        </Box>,
      );
      continue;
    }

    elements.push(
      <Box key={i}>
        <MarkdownLine text={line} />
      </Box>,
    );
  }

  return <>{elements}</>;
}

/**
 * Renders the terms document with markdown formatting and prompts the user
 * to press `y` to accept.
 * @param props - Component props.
 */
export function ConsentStep({ state, onAccept }: ConsentStepProps): React.JSX.Element {
  useInput((input) => {
    if (input === 'y' || input === 'Y') {
      onAccept();
    }
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Makaio Setup
        </Text>
        <Text dimColor> — Terms of Use (v{state.termsVersion})</Text>
      </Box>

      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} paddingY={0}>
        <RenderedTerms content={state.termsText} />
      </Box>

      <Box marginTop={1}>
        <Text color="green" bold>
          {'❯ '}
        </Text>
        <Text>Press </Text>
        <Text bold color="green">
          y
        </Text>
        <Text> to accept terms</Text>
      </Box>
    </Box>
  );
}
