import { z } from 'zod';

import { env } from '@/lib/env';
import { ConnectorError, type ConnectorDefinition } from './types';

/**
 * The connectors this agent can reach.
 *
 * Three of the four built-ins need no API key at all, which matters: a personal
 * agent that can answer "will it rain on Thursday" out of the box is more useful
 * than one that needs three signups first.
 */

/* -------------------------------------------------------------------------- */
/* Weather and geocoding — Open-Meteo, no key required                         */
/* -------------------------------------------------------------------------- */

const weather: ConnectorDefinition = {
  name: 'weather',
  description: 'Weather forecasts and historical weather for a latitude and longitude.',
  baseUrl: 'https://api.open-meteo.com',
  auth: { kind: 'none' },
  rateLimit: { calls: 60, windowSeconds: 3600 },
  operations: [
    {
      name: 'forecast',
      description:
        'Daily and hourly forecast for a coordinate. Use the geocoding connector first to turn a place name into a latitude and longitude.',
      method: 'GET',
      path: '/v1/forecast',
      query: ['latitude', 'longitude', 'daily', 'hourly', 'timezone', 'forecast_days'],
      input: z.object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        daily: z
          .string()
          .default('temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code')
          .describe('Comma-separated daily variables.'),
        hourly: z.string().optional().describe('Comma-separated hourly variables.'),
        timezone: z.string().default('auto').describe('IANA timezone, or "auto".'),
        forecast_days: z.number().int().min(1).max(16).default(7),
      }),
      // Open-Meteo returns parallel arrays plus a large units block; the units
      // are noise once the values are labelled.
      summarise: (body) => {
        const typed = body as {
          latitude?: number;
          longitude?: number;
          timezone?: string;
          daily?: Record<string, unknown[]>;
          hourly?: Record<string, unknown[]>;
        };
        return {
          latitude: typed.latitude,
          longitude: typed.longitude,
          timezone: typed.timezone,
          daily: zipSeries(typed.daily),
          hourly: typed.hourly ? zipSeries(typed.hourly).slice(0, 48) : undefined,
        };
      },
    },
  ],
};

const geocoding: ConnectorDefinition = {
  name: 'geocoding',
  description: 'Turn a place name into coordinates, and back.',
  baseUrl: 'https://geocoding-api.open-meteo.com',
  auth: { kind: 'none' },
  rateLimit: { calls: 60, windowSeconds: 3600 },
  operations: [
    {
      name: 'search',
      description: 'Find the coordinates, country, and timezone for a place name.',
      method: 'GET',
      path: '/v1/search',
      query: ['name', 'count', 'language'],
      input: z.object({
        name: z.string().min(1).max(120),
        count: z.number().int().min(1).max(10).default(5),
        language: z.string().length(2).default('en'),
      }),
      summarise: (body) => {
        const results = (body as { results?: unknown[] }).results ?? [];
        return results.map((entry) => {
          const place = entry as Record<string, unknown>;
          return {
            name: place.name,
            country: place.country,
            admin1: place.admin1,
            latitude: place.latitude,
            longitude: place.longitude,
            timezone: place.timezone,
            population: place.population,
          };
        });
      },
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* Exchange rates — Frankfurter, no key required                              */
/* -------------------------------------------------------------------------- */

const currency: ConnectorDefinition = {
  name: 'currency',
  description: 'Foreign exchange rates, current and historical, from the ECB.',
  baseUrl: 'https://api.frankfurter.dev',
  auth: { kind: 'none' },
  rateLimit: { calls: 60, windowSeconds: 3600 },
  operations: [
    {
      name: 'latest',
      description: 'Latest exchange rates for a base currency.',
      method: 'GET',
      path: '/v1/latest',
      query: ['base', 'symbols'],
      input: z.object({
        base: z.string().length(3).default('EUR').describe('ISO 4217 code, e.g. USD.'),
        symbols: z.string().optional().describe('Comma-separated codes to limit the result.'),
      }),
    },
    {
      name: 'on_date',
      description: 'Exchange rates as they were on a given date.',
      method: 'GET',
      // The date is a path segment, filled from a validated parameter and
      // percent-encoded, so it cannot inject a path of its own.
      path: '/v1/{date}',
      query: ['base', 'symbols'],
      input: z.object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
          .describe('The date to price at.'),
        base: z.string().length(3).default('EUR'),
        symbols: z.string().optional(),
      }),
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* GitHub — needs a token                                                     */
/* -------------------------------------------------------------------------- */

const github: ConnectorDefinition = {
  name: 'github',
  description: "Read repositories, issues, and pull requests on the user's behalf.",
  baseUrl: 'https://api.github.com',
  auth: { kind: 'bearer', envVar: 'GITHUB_TOKEN' },
  rateLimit: { calls: 100, windowSeconds: 3600 },
  setupHint: 'Set GITHUB_TOKEN to a fine-grained personal access token.',
  operations: [
    {
      name: 'list_issues',
      description: 'List issues on a repository, newest first.',
      method: 'GET',
      path: '/repos/{owner}/{repo}/issues',
      query: ['state', 'labels', 'per_page'],
      input: z.object({
        owner: z.string().min(1).max(100),
        repo: z.string().min(1).max(100),
        state: z.enum(['open', 'closed', 'all']).default('open'),
        labels: z.string().optional().describe('Comma-separated label names.'),
        per_page: z.number().int().min(1).max(50).default(20),
      }),
      summarise: (body) =>
        (Array.isArray(body) ? body : []).map((entry) => {
          const issue = entry as Record<string, unknown>;
          return {
            number: issue.number,
            title: issue.title,
            state: issue.state,
            user: (issue.user as { login?: string } | undefined)?.login,
            labels: (issue.labels as Array<{ name?: string }> | undefined)?.map((l) => l.name),
            comments: issue.comments,
            updated_at: issue.updated_at,
            url: issue.html_url,
          };
        }),
    },
    {
      name: 'get_issue',
      description: 'Read one issue, including its body.',
      method: 'GET',
      path: '/repos/{owner}/{repo}/issues/{number}',
      input: z.object({
        owner: z.string().min(1).max(100),
        repo: z.string().min(1).max(100),
        number: z.number().int().min(1),
      }),
      summarise: (body) => {
        const issue = body as Record<string, unknown>;
        return {
          number: issue.number,
          title: issue.title,
          state: issue.state,
          body: typeof issue.body === 'string' ? issue.body.slice(0, 8000) : null,
          user: (issue.user as { login?: string } | undefined)?.login,
          created_at: issue.created_at,
          url: issue.html_url,
        };
      },
    },
    {
      name: 'create_issue',
      description: 'Open a new issue on a repository.',
      method: 'POST',
      path: '/repos/{owner}/{repo}/issues',
      // Outward-facing and visible to other people, so it needs the user to
      // have actually asked.
      mutates: true,
      input: z.object({
        owner: z.string().min(1).max(100),
        repo: z.string().min(1).max(100),
        title: z.string().min(1).max(300),
        body: z.string().max(20_000).optional(),
        labels: z.array(z.string().min(1).max(50)).max(10).optional(),
      }),
      summarise: (body) => {
        const issue = body as Record<string, unknown>;
        return { number: issue.number, url: issue.html_url, state: issue.state };
      },
    },
  ],
};

const BUILT_IN: ConnectorDefinition[] = [weather, geocoding, currency, github];

/* -------------------------------------------------------------------------- */
/* Custom connectors, declared in configuration                               */
/* -------------------------------------------------------------------------- */

const customOperationSchema = z.object({
  name: z.string().min(1).max(60).regex(/^[a-z0-9_]+$/, 'Use lowercase, digits, and underscores.'),
  description: z.string().min(1).max(400),
  method: z.enum(['GET', 'POST']).default('GET'),
  path: z.string().min(1).max(300),
  query: z.array(z.string().min(1).max(60)).max(20).default([]),
  mutates: z.boolean().default(false),
  /** Parameter names and whether each is required. Values are always strings. */
  params: z
    .record(
      z.string().min(1).max(60),
      z.object({
        required: z.boolean().default(false),
        description: z.string().max(200).default(''),
      }),
    )
    .default({}),
});

const customConnectorSchema = z.object({
  name: z.string().min(1).max(40).regex(/^[a-z0-9_]+$/, 'Use lowercase, digits, and underscores.'),
  description: z.string().min(1).max(400),
  baseUrl: z.string().url(),
  auth: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('none') }),
      z.object({ kind: z.literal('bearer'), envVar: z.string().min(1), prefix: z.string().optional() }),
      z.object({ kind: z.literal('header'), envVar: z.string().min(1), header: z.string().min(1) }),
      z.object({ kind: z.literal('query'), envVar: z.string().min(1), parameter: z.string().min(1) }),
    ])
    .default({ kind: 'none' }),
  rateLimit: z
    .object({
      calls: z.number().int().min(1).max(10_000).default(60),
      windowSeconds: z.number().int().min(60).max(86_400).default(3600),
    })
    .default({ calls: 60, windowSeconds: 3600 }),
  operations: z.array(customOperationSchema).min(1).max(20),
});

/**
 * Connectors declared in `CUSTOM_CONNECTORS` as JSON.
 *
 * This is what makes the registry extensible without a code change: an operator
 * can point the agent at their own internal API by writing configuration. The
 * declarative shape is preserved, so a custom connector is no more powerful
 * than a built-in one — still a fixed host, still named operations, still
 * validated parameters, still no credential in the model's context.
 */
function customConnectors(): ConnectorDefinition[] {
  const raw = env.customConnectors;
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConnectorError(
      `CUSTOM_CONNECTORS is not valid JSON: ${error instanceof Error ? error.message : error}`,
    );
  }

  const result = z.array(customConnectorSchema).safeParse(parsed);
  if (!result.success) {
    throw new ConnectorError(
      `CUSTOM_CONNECTORS is not a valid connector list: ${result.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }

  return result.data.map((definition) => ({
    name: definition.name,
    description: definition.description,
    baseUrl: definition.baseUrl,
    auth: definition.auth,
    rateLimit: definition.rateLimit,
    operations: definition.operations.map((operation) => ({
      name: operation.name,
      description: operation.description,
      method: operation.method,
      path: operation.path,
      query: operation.query,
      mutates: operation.mutates,
      input: buildCustomInput(operation.params),
    })),
  }));
}

/** Turn a declared parameter map into a schema that rejects anything else. */
function buildCustomInput(
  params: Record<string, { required: boolean; description: string }>,
): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [name, spec] of Object.entries(params)) {
    const base = z
      .union([z.string().max(4000), z.number(), z.boolean()])
      .describe(spec.description);
    shape[name] = spec.required ? base : base.optional();
  }

  // `strict` so an undeclared parameter is an error rather than being forwarded
  // to somebody's API unchecked.
  return z.strictObject(shape) as unknown as z.ZodType<Record<string, unknown>>;
}

/* -------------------------------------------------------------------------- */
/* Lookup                                                                     */
/* -------------------------------------------------------------------------- */

let cached: ConnectorDefinition[] | undefined;

export function allConnectors(): ConnectorDefinition[] {
  cached ??= [...BUILT_IN, ...customConnectors()];
  return cached;
}

/** Only connectors whose credential is actually present. */
export function availableConnectors(): ConnectorDefinition[] {
  return allConnectors().filter((connector) => isConfigured(connector));
}

export function isConfigured(connector: ConnectorDefinition): boolean {
  if (connector.auth.kind === 'none') return true;
  return (process.env[connector.auth.envVar] ?? '').trim().length > 0;
}

export function findConnector(name: string): ConnectorDefinition | undefined {
  return allConnectors().find((connector) => connector.name === name);
}

/** Reset the memoised registry. Used by tests that change configuration. */
export function resetRegistry(): void {
  cached = undefined;
}

/**
 * Turn parallel arrays into records.
 *
 * Several weather APIs return `{ time: [...], temperature: [...] }`. A model
 * reading that has to index two arrays in step to get one day's values, and it
 * does sometimes get that wrong.
 */
function zipSeries(series: Record<string, unknown[]> | undefined): Array<Record<string, unknown>> {
  if (!series) return [];
  const keys = Object.keys(series);
  const length = Math.max(0, ...keys.map((key) => series[key]?.length ?? 0));

  return Array.from({ length }, (_, index) => {
    const row: Record<string, unknown> = {};
    for (const key of keys) row[key] = series[key]?.[index];
    return row;
  });
}
