import type { ToolSet } from 'ai';

import { connectorTools } from './connectors';
import { documentTools } from './documents';
import { emailTools } from './email';
import { scheduleTools } from './schedule';
import { webTools } from './web';
import { memoryTools } from './memory';
import { taskTools } from './tasks';
import { timeTools } from './time';
import type { AgentContext } from './context';

export type { AgentContext } from './context';

/**
 * Assemble the tool set for one agent turn.
 *
 * Tools are built per request rather than defined as module constants because
 * each one closes over the acting user: the model supplies what to do, never
 * whose data to do it to.
 *
 * The order here is the order the model sees, and it is stable across requests
 * so the cached prompt prefix keeps hitting.
 */
export function buildTools(context: AgentContext): ToolSet {
  return {
    ...timeTools(context),
    ...memoryTools(context),
    ...taskTools(context),
    ...documentTools(context),
    ...emailTools(context),
    ...webTools(context),
    ...scheduleTools(context),
    ...connectorTools(context),
  };
}
