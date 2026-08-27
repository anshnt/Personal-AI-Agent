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

  /**
   * Directory the agent may read files from.
   *
   * Unset means local file access is off. There is deliberately no default:
   * filesystem access for a model is opt-in, never inherited.
   */
  get filesDir(): string | undefined {
    return optional('AGENT_FILES_DIR');
  },

  /* ---------------------------------------------------------------- mail */

  /** `imap`, `local`, or unset to leave mail off entirely. */
  get mailProvider(): 'imap' | 'local' | undefined {
    const value = optional('MAIL_PROVIDER');
    return value === 'imap' || value === 'local' ? value : undefined;
  },

  /** Address the mailbox belongs to. Defaults to the user's own address. */
  get mailAddress(): string | undefined {
    return optional('MAIL_ADDRESS');
  },

  get imapHost(): string | undefined {
    return optional('IMAP_HOST');
  },

  get imapPort(): number {
    const parsed = Number.parseInt(optional('IMAP_PORT') ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 993;
  },

  get imapUser(): string | undefined {
    return optional('IMAP_USER');
  },

  /**
   * IMAP password, read at connect time and never persisted.
   *
   * For Gmail and Outlook this must be an app password: those providers reject
   * the account password over IMAP.
   */
  get imapPassword(): string | undefined {
    return optional('IMAP_PASSWORD');
  },

  /** Directory of `.eml` files, for the local mail provider. */
  get mailLocalDir(): string | undefined {
    return optional('MAIL_LOCAL_DIR');
  },

  /* ----------------------------------------------------------------- web */

  /** Force a specific search backend. Otherwise whichever key is set wins. */
  get searchProvider(): 'brave' | 'tavily' | 'searxng' | undefined {
    const value = optional('SEARCH_PROVIDER');
    return value === 'brave' || value === 'tavily' || value === 'searxng' ? value : undefined;
  },

  get braveSearchApiKey(): string | undefined {
    return optional('BRAVE_SEARCH_API_KEY');
  },

  get tavilyApiKey(): string | undefined {
    return optional('TAVILY_API_KEY');
  },

  /** Base URL of a self-hosted SearXNG instance. */
  get searxngUrl(): string | undefined {
    return optional('SEARXNG_URL');
  },

  /* ------------------------------------------------------------ schedules */

  /**
   * Shared secret for `/api/cron`.
   *
   * Unset disables the endpoint entirely rather than leaving it open: anyone
   * who found the URL could otherwise make this application spend tokens on
   * every scheduled agent run, as often as they liked.
   */
  get cronSecret(): string | undefined {
    return optional('CRON_SECRET');
  },

  /* ----------------------------------------------------------- connectors */

  /**
   * Extra connectors, as a JSON array.
   *
   * Lets an operator point the agent at their own API without a code change,
   * while keeping the declarative shape: fixed host, named operations,
   * validated parameters, credential never in the model's context.
   */
  get customConnectors(): string | undefined {
    return optional('CUSTOM_CONNECTORS');
  },

  /* ---------------------------------------------------------- embeddings */

  /**
   * Voyage is the default embedding provider: Anthropic publishes no embedding
   * model, and Voyage is their recommended partner. Optional — with no provider
   * configured, memory recall stays lexical.
   */
  get voyageApiKey(): string | undefined {
    return optional('VOYAGE_API_KEY');
  },

  get voyageEmbeddingModel(): string {
    return optional('VOYAGE_EMBEDDING_MODEL') ?? 'voyage-3.5';
  },

  /** OpenAI as an alternative, for a deployment that already has a key. */
  get openAiApiKey(): string | undefined {
    return optional('OPENAI_API_KEY');
  },

  get openAiEmbeddingModel(): string {
    return optional('OPENAI_EMBEDDING_MODEL') ?? 'text-embedding-3-small';
  },

  get isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
  },

  optional,
} as const;
