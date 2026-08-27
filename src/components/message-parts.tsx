'use client';

import {
  getToolOrDynamicToolName,
  isDynamicToolUIPart,
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from 'ai';

/**
 * Render one message's parts.
 *
 * Tool calls and reasoning are shown as collapsed disclosures rather than
 * hidden: for an agent that reads your mail and edits your task list, being
 * able to see exactly what it did is the difference between trusting it and
 * not. They stay collapsed so the answer is still the thing you read first.
 */
export function MessageParts({ message }: { message: UIMessage }) {
  return (
    <>
      {message.parts.map((part, index) => {
        const key = `${message.id}-${index}`;

        if (part.type === 'text') {
          return (
            <div className="bubble" key={key}>
              {splitParagraphs(part.text).map((paragraph, i) => (
                <p key={i}>{paragraph}</p>
              ))}
            </div>
          );
        }

        if (part.type === 'reasoning') {
          if (part.text.trim().length === 0) return null;
          return (
            <details className="trace" key={key}>
              <summary>
                <span className="tool-name">thinking</span>
              </summary>
              <div className="reasoning">{part.text}</div>
            </details>
          );
        }

        if (isToolUIPart(part) || isDynamicToolUIPart(part)) {
          return <ToolTrace key={key} part={part} />;
        }

        return null;
      })}
    </>
  );
}

/**
 * Both flavours of tool part render identically: a statically declared tool and
 * one supplied at runtime differ in how they were defined, not in what the
 * trace needs to show.
 */
type ToolPart = ToolUIPart | DynamicToolUIPart;

function ToolTrace({ part }: { part: ToolPart }) {
  const name = getToolOrDynamicToolName(part);
  const failed = part.state === 'output-error';

  return (
    <details className="trace">
      <summary>
        <span className="tool-name">{name}</span>
        <span className={failed ? 'tool-state error' : 'tool-state'}>{label(part.state)}</span>
      </summary>
      {part.input !== undefined && <pre>{format(part.input)}</pre>}
      {part.state === 'output-available' && <pre>{format(part.output)}</pre>}
      {failed && <pre>{part.errorText}</pre>}
    </details>
  );
}

function label(state: ToolPart['state']): string {
  switch (state) {
    case 'input-streaming':
      return 'preparing';
    case 'input-available':
      return 'running';
    case 'output-available':
      return 'done';
    case 'output-error':
      return 'failed';
    default:
      return state;
  }
}

function format(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Preserve the model's paragraph breaks without pulling in a markdown parser. */
function splitParagraphs(text: string): string[] {
  const paragraphs = text.split(/\n{2,}/).map((block) => block.trim());
  const nonEmpty = paragraphs.filter((block) => block.length > 0);
  return nonEmpty.length > 0 ? nonEmpty : [text];
}
