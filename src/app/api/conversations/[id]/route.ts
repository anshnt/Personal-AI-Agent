import { deleteConversation, loadMessages } from '@/lib/conversations';
import { resolveCurrentUser } from '@/lib/db/users';
import { db } from '@/lib/db';
import { conversations } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;

  try {
    const user = await resolveCurrentUser();

    // Check ownership before reading history: message rows carry no user id.
    const owned = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.userId, user.id)))
      .limit(1);

    if (!owned[0]) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    return Response.json({ messages: await loadMessages(id) });
  } catch (error) {
    console.error('[conversations] load failed', error);
    return Response.json({ error: 'Could not load the conversation' }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;

  try {
    const user = await resolveCurrentUser();
    const deleted = await deleteConversation(user.id, id);
    return deleted
      ? new Response(null, { status: 204 })
      : Response.json({ error: 'Not found' }, { status: 404 });
  } catch (error) {
    console.error('[conversations] delete failed', error);
    return Response.json({ error: 'Could not delete the conversation' }, { status: 500 });
  }
}
