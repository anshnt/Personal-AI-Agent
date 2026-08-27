import { env } from '@/lib/env';
import { safeFetch } from './guard';

/**
 * Search backends.
 *
 * Three, because there is no single right answer: Brave has a usable free tier
 * and a clean JSON API, Tavily is tuned for exactly this use case and returns
 * pre-extracted content, and SearXNG needs no key at all if the user already
 * self-hosts one. Each returns the same shape, so the tool layer does not know
 * or care which is configured.
 */

export class SearchError extends Error {}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Some providers return extracted page text, which saves a fetch. */
  content?: string;
  publishedAt?: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, limit: number): Promise<SearchResult[]>;
}

/* -------------------------------------------------------------------------- */
/* Brave                                                                      */
/* -------------------------------------------------------------------------- */

interface BraveItem {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
}

interface BraveResponse {
  web?: { results?: BraveItem[] };
}

export class BraveSearchProvider implements SearchProvider {
  readonly name = 'brave';

  constructor(private readonly apiKey: string) {}

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(Math.min(limit, 20)));

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': this.apiKey,
      },
      signal: AbortSignal.timeout(15_000),
    }).catch((error: unknown) => {
      throw new SearchError(
        `Brave Search is unreachable: ${error instanceof Error ? error.message : error}`,
      );
    });

    if (!response.ok) {
      throw new SearchError(
        response.status === 401 || response.status === 403
          ? 'Brave Search rejected the API key. Check BRAVE_SEARCH_API_KEY.'
          : `Brave Search returned ${response.status}.`,
      );
    }

    const body = (await response.json()) as BraveResponse;

    return (body.web?.results ?? [])
      .filter((entry): entry is BraveItem & { url: string } => typeof entry.url === 'string')
      .map((entry) => ({
        title: entry.title ?? entry.url,
        url: entry.url,
        snippet: stripTags(entry.description ?? ''),
        publishedAt: entry.age,
      }));
  }
}

/* -------------------------------------------------------------------------- */
/* Tavily                                                                     */
/* -------------------------------------------------------------------------- */

interface TavilyItem {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
}

interface TavilyResponse {
  results?: TavilyItem[];
  answer?: string;
}

export class TavilySearchProvider implements SearchProvider {
  readonly name = 'tavily';

  constructor(private readonly apiKey: string) {}

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: Math.min(limit, 20),
        // Tavily can return extracted page text, which often removes the need
        // for a follow-up fetch entirely.
        include_raw_content: false,
        search_depth: 'basic',
      }),
      signal: AbortSignal.timeout(20_000),
    }).catch((error: unknown) => {
      throw new SearchError(
        `Tavily is unreachable: ${error instanceof Error ? error.message : error}`,
      );
    });

    if (!response.ok) {
      throw new SearchError(
        response.status === 401
          ? 'Tavily rejected the API key. Check TAVILY_API_KEY.'
          : `Tavily returned ${response.status}.`,
      );
    }

    const body = (await response.json()) as TavilyResponse;

    return (body.results ?? [])
      .filter((entry): entry is TavilyItem & { url: string } => typeof entry.url === 'string')
      .map((entry) => ({
        title: entry.title ?? entry.url,
        url: entry.url,
        snippet: (entry.content ?? '').slice(0, 500),
        content: entry.content,
        publishedAt: entry.published_date,
      }));
  }
}

/* -------------------------------------------------------------------------- */
/* SearXNG                                                                    */
/* -------------------------------------------------------------------------- */

interface SearxItem {
  title?: string;
  url?: string;
  content?: string;
  publishedDate?: string;
}

interface SearxResponse {
  results?: SearxItem[];
}

/**
 * A self-hosted SearXNG instance.
 *
 * Fetched through the SSRF guard rather than plain `fetch`, because the endpoint
 * is operator-supplied configuration and should be validated like any other
 * outbound target. A self-hosted instance on loopback needs its host added to
 * `WEB_FETCH_ALLOW_HOSTS`, which is the explicit opt-in that guard requires.
 */
export class SearxngSearchProvider implements SearchProvider {
  readonly name = 'searxng';

  constructor(private readonly baseUrl: string) {}

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const url = new URL('/search', this.baseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');

    const response = await safeFetch(url.toString(), { timeoutMs: 20_000 }).catch(
      (error: unknown) => {
        throw new SearchError(
          `SearXNG at ${this.baseUrl} is unreachable: ${error instanceof Error ? error.message : error}`,
        );
      },
    );

    if (response.status !== 200) {
      throw new SearchError(`SearXNG returned ${response.status}.`);
    }

    let body: SearxResponse;
    try {
      body = JSON.parse(response.body) as SearxResponse;
    } catch {
      throw new SearchError(
        'SearXNG did not return JSON. The instance may need the json format enabled in settings.yml.',
      );
    }

    return (body.results ?? [])
      .filter((entry): entry is SearxItem & { url: string } => typeof entry.url === 'string')
      .slice(0, limit)
      .map((entry) => ({
        title: entry.title ?? entry.url,
        url: entry.url,
        snippet: (entry.content ?? '').slice(0, 500),
        publishedAt: entry.publishedDate,
      }));
  }
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build the configured provider, or undefined when search is switched off.
 *
 * Explicit `SEARCH_PROVIDER` wins; otherwise whichever key is present is used,
 * so a single `BRAVE_SEARCH_API_KEY` is enough to turn search on.
 */
export function configuredProvider(): SearchProvider | undefined {
  const requested = env.searchProvider;

  if (requested === 'brave' || (!requested && env.braveSearchApiKey)) {
    const key = env.braveSearchApiKey;
    if (!key) return undefined;
    return new BraveSearchProvider(key);
  }

  if (requested === 'tavily' || (!requested && env.tavilyApiKey)) {
    const key = env.tavilyApiKey;
    if (!key) return undefined;
    return new TavilySearchProvider(key);
  }

  if (requested === 'searxng' || (!requested && env.searxngUrl)) {
    const url = env.searxngUrl;
    if (!url) return undefined;
    return new SearxngSearchProvider(url);
  }

  return undefined;
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, '').trim().slice(0, 500);
}
