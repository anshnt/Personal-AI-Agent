import { z } from 'zod';

import { resolveCurrentUser } from '@/lib/db/users';
import { mailboxStatus, searchEmail } from '@/lib/email/store';
import { ensureConfiguredAccount, syncAllAccounts } from '@/lib/email/sync';

export const maxDuration = 120;

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await resolveCurrentUser();
    await ensureConfiguredAccount(user.id);

    const params = new URL(request.url).searchParams;
    const hits = await searchEmail({
      userId: user.id,
      query: params.get('q') ?? undefined,
      from: params.get('from') ?? undefined,
      limit: 50,
    });

    return Response.json({
      accounts: await mailboxStatus(user.id),
      messages: hits.map((hit) => ({
        id: hit.id,
        from: hit.fromName ? `${hit.fromName} <${hit.fromAddress}>` : hit.fromAddress,
        subject: hit.subject,
        snippet: hit.snippet,
        received_at: hit.receivedAt.toISOString(),
        labels: hit.labels,
        attachments: hit.attachmentNames,
      })),
    });
  } catch (error) {
    console.error('[email] list failed', error);
    return Response.json({ error: 'Could not load mail' }, { status: 500 });
  }
}

const syncBody = z.object({
  limit: z.number().int().min(1).max(500).default(100),
  full: z.boolean().default(false),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const raw: unknown = await request.json().catch(() => ({}));
    const body = syncBody.parse(raw);

    const user = await resolveCurrentUser();
    const accounts = await ensureConfiguredAccount(user.id);
    if (accounts.length === 0) {
      return Response.json(
        { error: 'No mail account is configured. Set MAIL_PROVIDER.' },
        { status: 400 },
      );
    }

    return Response.json({ accounts: await syncAllAccounts(user.id, body) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sync failed';
    console.error('[email] sync failed', error);
    return Response.json({ error: message }, { status: 500 });
  }
}
