import { z } from 'zod';

import { resolveCurrentUser } from '@/lib/db/users';
import { purgeExpired } from '@/lib/web/cache';
import { SearchError, configuredProvider } from '@/lib/web/providers';
import { runSearch } from '@/lib/web/search';

export const maxDuration = 60;

const query = z.object({
  q: z.string().min(2).max(400),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const parsed = query.safeParse({
    q: params.get('q') ?? '',
    limit: params.get('limit') ?? undefined,
  });

  if (!parsed.success) {
    return Response.json({ error: 'Pass ?q= with at least two characters' }, { status: 400 });
  }

  if (!configuredProvider()) {
    return Response.json(
      { error: 'Web search is not configured. Set BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, or SEARXNG_URL.' },
      { status: 400 },
    );
  }

  try {
    const user = await resolveCurrentUser();
    const run = await runSearch({
      userId: user.id,
      query: parsed.data.q,
      limit: parsed.data.limit,
    });

    return Response.json({
      provider: run.provider,
      cached: run.cached,
      dropped: run.dropped,
      results: run.results,
    });
  } catch (error) {
    if (error instanceof SearchError) {
      return Response.json({ error: error.message }, { status: 502 });
    }
    console.error('[web] search failed', error);
    return Response.json({ error: 'Search failed' }, { status: 500 });
  }
}

/** Drop expired cache rows. Point a cron at this if the cache grows. */
export async function DELETE(): Promise<Response> {
  try {
    return Response.json({ purged: await purgeExpired() });
  } catch (error) {
    console.error('[web] purge failed', error);
    return Response.json({ error: 'Purge failed' }, { status: 500 });
  }
}
