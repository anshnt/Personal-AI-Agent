import { z } from 'zod';

import { resolveCurrentUser } from '@/lib/db/users';
import { listMemories, remember } from '@/lib/memory/store';

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await resolveCurrentUser();
    const kind = new URL(request.url).searchParams.get('kind');
    const parsedKind = z.enum(['fact', 'preference', 'episode', 'directive']).safeParse(kind);

    const rows = await listMemories(user.id, {
      kind: parsedKind.success ? parsedKind.data : undefined,
      limit: 200,
    });

    return Response.json({
      memories: rows.map((memory) => ({
        id: memory.id,
        kind: memory.kind,
        content: memory.content,
        tags: memory.tags,
        importance: memory.importance,
        source: memory.source,
        created_at: memory.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error('[memories] list failed', error);
    return Response.json({ error: 'Could not load memories' }, { status: 500 });
  }
}

const createBody = z.object({
  content: z.string().min(4).max(400),
  kind: z.enum(['fact', 'preference', 'episode', 'directive']).default('fact'),
  importance: z.number().min(0).max(1).default(0.5),
  tags: z.array(z.string().min(1).max(24)).max(6).default([]),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const body = createBody.parse(await request.json());
    const user = await resolveCurrentUser();

    const created = await remember({
      userId: user.id,
      content: body.content,
      kind: body.kind,
      importance: body.importance,
      tags: body.tags,
      source: 'manual',
    });

    return Response.json({ id: created.id, content: created.content }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request';
    return Response.json({ error: message }, { status: 400 });
  }
}
