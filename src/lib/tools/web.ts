import { tool } from 'ai';
import { z } from 'zod';

import { wrapUntrusted } from '@/lib/untrusted';
import { cachedFetch, isCached } from '@/lib/web/cache';
import { extractReadable } from '@/lib/web/extract';
import { FetchFailedError, UnsafeUrlError, safeFetch } from '@/lib/web/guard';
import { SearchError, configuredProvider } from '@/lib/web/providers';
import { runSearch } from '@/lib/web/search';
import { failure, instrument, type AgentContext } from './context';

/** Page text returned in one call. Enough for an article, short of a prompt flood. */
const PAGE_CHARS = 24_000;
/** A page's content is stable enough to reuse inside one conversation. */
const FETCH_TTL_SECONDS = 30 * 60;

interface CachedPage {
  finalUrl: string;
  status: number;
  title: string | null;
  description: string | null;
  text: string;
  truncated: boolean;
  redirects: string[];
}

export function webTools(context: AgentContext) {
  return {
    web_search: tool({
      description:
        'Search the web. Use it for anything you would otherwise be guessing at: current events, prices, documentation, anything after your training cutoff. Returns titles, URLs, and snippets — follow up with web_fetch to read a page properly before relying on it.',
      inputSchema: z.object({
        query: z.string().min(2).max(400).describe('What to search for, in plain language.'),
        limit: z.number().int().min(1).max(20).default(8),
      }),
      execute: instrument('web_search', context, async (input) => {
        if (!configuredProvider()) {
          return failure(
            'Web search is not configured. The operator sets BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, or SEARXNG_URL.',
          );
        }

        try {
          const run = await runSearch({
            userId: context.user.id,
            query: input.query,
            limit: input.limit,
          });

          return {
            ok: true as const,
            provider: run.provider,
            query: run.query,
            from_cache: run.cached,
            count: run.results.length,
            // Snippets are written by whoever runs the site, so they are framed
            // as data even though they are short.
            results: run.results.map((result) => ({
              title: result.title,
              url: result.url,
              snippet: wrapUntrusted(
                { kind: 'search result snippet', origin: hostOf(result.url) },
                result.snippet,
              ),
              published: result.publishedAt ?? null,
            })),
            unsafe_results_dropped: run.dropped,
            next_step:
              run.results.length > 0
                ? 'Snippets are not enough to answer from. Fetch the pages that matter.'
                : 'Nothing usable came back. Try different words before telling the user it does not exist.',
          };
        } catch (error) {
          if (error instanceof SearchError) return failure(error.message);
          throw error;
        }
      }),
    }),

    web_fetch: tool({
      description:
        'Fetch a web page and return its readable text. Use it to actually read something you found with web_search, or a URL the user gave you. Private, loopback, and cloud-metadata addresses are refused.',
      inputSchema: z.object({
        url: z.string().min(8).max(2000).describe('An absolute http or https URL.'),
      }),
      execute: instrument('web_fetch', context, async (input) => {
        const cacheKey = input.url.trim();

        try {
          const fromCache = await isCached({
            userId: context.user.id,
            kind: 'fetch',
            key: cacheKey,
          });

          const page = await cachedFetch<CachedPage>(
            {
              userId: context.user.id,
              kind: 'fetch',
              key: cacheKey,
              ttlSeconds: FETCH_TTL_SECONDS,
            },
            async () => {
              const response = await safeFetch(input.url);
              const readable = extractReadable(response.body, response.finalUrl);
              return {
                finalUrl: response.finalUrl,
                status: response.status,
                title: readable.title,
                description: readable.description,
                text: readable.text,
                truncated: response.truncated,
                redirects: response.redirects,
              };
            },
          );

          const origin = hostOf(page.finalUrl);

          return {
            ok: true as const,
            url: page.finalUrl,
            status: page.status,
            from_cache: fromCache,
            title: page.title,
            description: page.description,
            redirected_through: page.redirects,
            // The whole page is somebody else's writing, and a page can be
            // authored specifically to be read by an agent with tools.
            content: wrapUntrusted(
              { kind: 'web page', origin },
              page.text.slice(0, PAGE_CHARS),
            ),
            content_truncated: page.truncated || page.text.length > PAGE_CHARS,
          };
        } catch (error) {
          // Both refusal kinds are expected outcomes the model should be told
          // about plainly, rather than turn-aborting exceptions.
          if (error instanceof UnsafeUrlError) {
            return failure(`Refused: ${error.message}`);
          }
          if (error instanceof FetchFailedError) {
            return failure(error.message);
          }
          throw error;
        }
      }),
    }),
  };
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return raw;
  }
}
