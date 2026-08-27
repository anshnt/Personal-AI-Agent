import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';

import { env } from '@/lib/env';

/**
 * The provider is created lazily so importing this module never requires a key.
 * Route handlers touch `agentModel()` only once they are actually serving a
 * request, which keeps `next build` and unit tests key-free.
 */
let provider: ReturnType<typeof createAnthropic> | undefined;

function anthropic(): ReturnType<typeof createAnthropic> {
  provider ??= createAnthropic({ apiKey: env.anthropicApiKey });
  return provider;
}

/** The model that drives the interactive agent loop. */
export function agentModel(): LanguageModel {
  return anthropic()(env.agentModel);
}

/**
 * A smaller model for short structured background calls — memory extraction and
 * conversation titling. These run on every turn, so they should not cost what
 * the main loop costs.
 */
export function utilityModel(): LanguageModel {
  return anthropic()(env.utilityModel);
}

/**
 * Provider options for the agent loop.
 *
 * Adaptive thinking lets the model decide how much to reason per turn, which
 * matters for an agent whose turns range from "what's on my list" to
 * multi-tool research. `display: 'summarized'` is set explicitly because the
 * default omits reasoning text, which would make the UI look stalled while the
 * model thinks.
 */
export function agentProviderOptions() {
  return {
    anthropic: {
      thinking: { type: 'adaptive' as const, display: 'summarized' as const },
      effort: env.agentEffort,
    },
  };
}

/** Background calls should be fast and cheap, so reasoning stays off. */
export function utilityProviderOptions() {
  return {
    anthropic: {
      thinking: { type: 'disabled' as const },
    },
  };
}
