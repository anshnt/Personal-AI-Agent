import { cachedFetch, isCached } from './cache';
import { screenUrl } from './guard';
import { SearchError, configuredProvider, type SearchProvider, type SearchResult } from './providers';

export interface RunSearchOptions {
  userId: string;
  query: string;
  limit?: number;
  /** Injected for tests; otherwise resolved from configuration. */
  provider?: SearchProvider;
  ttlSeconds?: number;
}

export interface SearchRun {
  provider: string;
  query: string;
  results: SearchResult[];
  cached: boolean;
  /** Results dropped because their URL failed the safety checks. */
  dropped: number;
}

/** Search results go stale, but not within one conversation. */
const DEFAULT_TTL_SECONDS = 15 * 60;

/**
 * Run a search, cache it, and sanitise the results.
 *
 * Results are validated before they reach the model, not just before a fetch.
 * A search provider is an outside party: a result pointing at
 * `http://169.254.169.254/` should never appear as a link the agent might
 * follow, and dropping it here means the model never sees it at all.
 */
export async function runSearch(options: RunSearchOptions): Promise<SearchRun> {
  const query = options.query.trim();
  if (query.length < 2) {
    throw new SearchError('Give a search query of at least two characters.');
  }

  const provider = options.provider ?? configuredProvider();
  if (!provider) {
    throw new SearchError(
      'Web search is not configured. The operator sets BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, or SEARXNG_URL.',
    );
  }

  const limit = Math.min(Math.max(options.limit ?? 8, 1), 20);
  // The provider and limit are part of the key: switching providers or asking
  // for more results should not be served a narrower cached answer.
  const cacheKey = `${provider.name}:${limit}:${query.toLowerCase()}`;

  const alreadyCached = await isCached({ userId: options.userId, kind: 'search', key: cacheKey });

  const raw = await cachedFetch<SearchResult[]>(
    {
      userId: options.userId,
      kind: 'search',
      key: cacheKey,
      ttlSeconds: options.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    },
    () => provider.search(query, limit),
  );

  const seen = new Set<string>();
  const results: SearchResult[] = [];
  let dropped = 0;

  for (const result of raw) {
    // Providers do return the same page under two URLs, and a duplicate in a
    // result list reads to the model as corroboration when it is not.
    const key = canonicalise(result.url);
    if (key === undefined) {
      dropped += 1;
      continue;
    }
    if (seen.has(key)) continue;

    if (!isSafeUrl(result.url)) {
      dropped += 1;
      continue;
    }

    seen.add(key);
    results.push(result);
    if (results.length >= limit) break;
  }

  return { provider: provider.name, query, results, cached: alreadyCached, dropped };
}

/** Strip the parts of a URL that do not change which page it is. */
function canonicalise(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const parameter of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|ref_|fbclid$|gclid$|mc_)/i.test(parameter)) {
        url.searchParams.delete(parameter);
      }
    }
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Screen a result URL, without DNS.
 *
 * The cheap checks are what matter here: a result pointing at a private address,
 * a non-web port, or a `file://` URL must never reach the model. Resolving each
 * result would add a DNS round trip per hit and would drop a good result
 * whenever a resolver hiccuped, and `web_fetch` runs the full check anyway
 * before anything is actually retrieved.
 */
function isSafeUrl(raw: string): boolean {
  try {
    screenUrl(raw);
    return true;
  } catch {
    return false;
  }
}
