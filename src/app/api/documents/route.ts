import { resolveCurrentUser } from '@/lib/db/users';
import { ingestDocument, listDocuments } from '@/lib/documents/store';

/** Uploads are capped well below the parser's text limit to bound memory use. */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export async function GET(): Promise<Response> {
  try {
    const user = await resolveCurrentUser();
    const rows = await listDocuments(user.id);

    return Response.json({
      documents: rows.map((document) => ({
        id: document.id,
        name: document.name,
        kind: document.kind,
        size_bytes: document.sizeBytes,
        characters: document.content.length,
        source: document.source,
        metadata: document.metadata,
        created_at: document.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error('[documents] list failed', error);
    return Response.json({ error: 'Could not load documents' }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: 'Expected a multipart form upload' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return Response.json({ error: 'Attach the document as the "file" field' }, { status: 400 });
  }
  if (file.size === 0) {
    return Response.json({ error: 'That file is empty' }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json(
      { error: `That file is larger than the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit` },
      { status: 413 },
    );
  }

  try {
    const user = await resolveCurrentUser();
    const bytes = new Uint8Array(await file.arrayBuffer());

    const result = await ingestDocument({
      userId: user.id,
      name: file.name,
      bytes,
      mimeType: file.type || undefined,
      source: 'upload',
    });

    return Response.json(
      {
        id: result.document.id,
        name: result.document.name,
        kind: result.document.kind,
        characters: result.document.content.length,
        chunks: result.chunks,
        replaced: result.replaced,
        metadata: result.document.metadata,
      },
      { status: result.replaced ? 200 : 201 },
    );
  } catch (error) {
    // Parse failures carry a message written for a person to read.
    const message = error instanceof Error ? error.message : 'Could not process that file';
    console.error('[documents] ingest failed', error);
    return Response.json({ error: message }, { status: 422 });
  }
}
