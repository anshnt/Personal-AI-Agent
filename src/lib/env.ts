/**
 * Environment access.
 *
 * Every value is read lazily so that build-time and test-time imports never
 * explode on a missing secret. Call sites that genuinely need a value use the
 * `require*` helpers, which fail loudly with an actionable message.
 */

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function required(name: string, hint: string): string {
  const value = optional(name);
  if (value === undefined) {
    throw new Error(`Missing required environment variable ${name}. ${hint}`);
  }
  return value;
}

export const env = {
  get databaseUrl(): string {
    return required(
      'DATABASE_URL',
      'Set it to a PostgreSQL connection string, e.g. postgres://user:pass@localhost:5432/personal_ai_agent',
    );
  },

  get anthropicApiKey(): string {
    return required(
      'ANTHROPIC_API_KEY',
      'Create a key at https://console.anthropic.com/settings/keys and add it to .env.local',
    );
  },

  /** Model used for the interactive agent loop. */
  get agentModel(): string {
    return optional('AGENT_MODEL') ?? 'claude-opus-5';
  },

  /**
   * Model used for cheap background work (memory extraction, titling).
   * Deliberately smaller than the agent model: these are short, structured calls.
   */
  get utilityModel(): string {
    return optional('UTILITY_MODEL') ?? 'claude-haiku-4-5';
  },

  /**
   * Reasoning effort for the agent loop. `high` is the default across the
   * Claude API and is a good balance for tool-using agents.
   */
  get agentEffort(): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
    const value = optional('AGENT_EFFORT');
    return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max'
      ? value
      : 'high';
  },

  /** Maximum tool-calling steps in a single agent turn. */
  get maxAgentSteps(): number {
    const parsed = Number.parseInt(optional('MAX_AGENT_STEPS') ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
  },

  /**
   * Single-user deployments (the common case for a personal agent) resolve
   * every request to this identity instead of requiring a login.
   */
  get defaultUserEmail(): string {
    return optional('DEFAULT_USER_EMAIL') ?? 'owner@localhost';
  },

  get defaultUserName(): string | undefined {
    return optional('DEFAULT_USER_NAME');
  },

  get defaultUserTimezone(): string {
    return optional('DEFAULT_USER_TIMEZONE') ?? 'UTC';
  },

  get isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
  },

  optional,
} as const;
