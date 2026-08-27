import { resolveCurrentUser } from '@/lib/db/users';
import { deleteDocument, getDocument } from '@/lib/documents/store';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;

  try {
    const user = await resolveCurrentUser();
    const document = await getDocument(user.id, id);
    if (!document) return Response.json({ error: 'Not found' }, { status: 404 });

    return Response.json({
      id: document.id,
      name: document.name,
      kind: document.kind,
      size_bytes: document.sizeBytes,
      source: document.source,
      metadata: document.metadata,
      content: document.content,
      created_at: document.createdAt.toISOString(),
    });
  } catch (error) {
    console.error('[documents] read failed', error);
    return Response.json({ error: 'Could not read the document' }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;

  try {
    const user = await resolveCurrentUser();
    const deleted = await deleteDocument(user.id, id);
    return deleted
      ? new Response(null, { status: 204 })
      : Response.json({ error: 'Not found' }, { status: 404 });
  } catch (error) {
    console.error('[documents] delete failed', error);
    return Response.json({ error: 'Could not delete the document' }, { status: 500 });
  }
}
