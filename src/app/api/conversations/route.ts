import { listConversations } from '@/lib/conversations';
import { resolveCurrentUser } from '@/lib/db/users';

export async function GET(): Promise<Response> {
  try {
    const user = await resolveCurrentUser();
    const rows = await listConversations(user.id);

    return Response.json({
      conversations: rows.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        updated_at: conversation.updatedAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error('[conversations] list failed', error);
    return Response.json({ error: 'Could not load conversations' }, { status: 500 });
  }
}
