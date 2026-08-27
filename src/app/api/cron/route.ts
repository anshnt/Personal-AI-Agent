import { timingSafeEqual } from 'node:crypto';

import { env } from '@/lib/env';
import { tick } from '@/lib/schedule/runner';

/** Scheduled agent runs make model calls, so a tick can take a while. */
export const maxDuration = 300;

/**
 * Fire the schedules that are due.
 *
 * Meant to be pinged every minute or so by whatever scheduler the deployment
 * already has: Vercel Cron, a systemd timer, a Kubernetes CronJob, or plain
 * `curl` from crontab. Claiming is atomic, so pinging it twice at once, or from
 * two instances, is safe.
 *
 * Authentication is mandatory. Without it, anyone who finds the URL can make
 * this application spend tokens on every scheduled agent run, as often as they
 * like — so an unset secret disables the endpoint rather than leaving it open.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = env.cronSecret;
  if (!secret) {
    return Response.json(
      {
        error:
          'Scheduling is not enabled. Set CRON_SECRET, then call this endpoint with it as a bearer token.',
      },
      { status: 503 },
    );
  }

  if (!isAuthorised(request, secret)) {
    return Response.json({ error: 'Unauthorised' }, { status: 401 });
  }

  try {
    const result = await tick();
    return Response.json(result);
  } catch (error) {
    console.error('[cron] tick failed', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Tick failed' },
      { status: 500 },
    );
  }
}

/** GET is accepted too, because some schedulers can only issue a GET. */
export async function GET(request: Request): Promise<Response> {
  return POST(request);
}

function isAuthorised(request: Request, secret: string): boolean {
  const header = request.headers.get('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  // Vercel Cron sends the secret as a bearer token; a plain header is accepted
  // as well so a hand-written curl does not need the prefix.
  const provided = bearer || request.headers.get('x-cron-secret') || '';

  return constantTimeEquals(provided, secret);
}

/**
 * Compare without leaking length or content through timing.
 *
 * `timingSafeEqual` throws on differing lengths, which would itself be an oracle,
 * so both sides are hashed to a fixed width first.
 */
function constantTimeEquals(left: string, right: string): boolean {
  if (left.length === 0) return false;
  const encoder = new TextEncoder();
  const a = Buffer.from(encoder.encode(left));
  const b = Buffer.from(encoder.encode(right));
  if (a.length !== b.length) {
    // Still do a comparison so the failure path costs the same either way.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}
