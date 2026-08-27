import { resolveCurrentUser } from '@/lib/db/users';
import { purgeOldWindows } from '@/lib/connectors/limiter';
import { allConnectors, isConfigured } from '@/lib/connectors/registry';
import { ConnectorError } from '@/lib/connectors/types';

export async function GET(): Promise<Response> {
  try {
    await resolveCurrentUser();

    return Response.json({
      connectors: allConnectors().map((connector) => ({
        name: connector.name,
        description: connector.description,
        available: isConfigured(connector),
        setup_hint: isConfigured(connector) ? null : (connector.setupHint ?? null),
        rate_limit: connector.rateLimit,
        // Credentials are never included here, in any form: not the value, not
        // its length, not whether it looks well-formed.
        auth: connector.auth.kind,
        operations: connector.operations.map((operation) => ({
          name: operation.name,
          description: operation.description,
          method: operation.method,
          mutates: operation.mutates === true,
        })),
      })),
    });
  } catch (error) {
    // A malformed CUSTOM_CONNECTORS is a configuration error worth reporting
    // plainly, since nothing else will tell the operator it is broken.
    if (error instanceof ConnectorError) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    console.error('[connectors] list failed', error);
    return Response.json({ error: 'Could not list connectors' }, { status: 500 });
  }
}

/** Drop counter rows for windows that have passed. */
export async function DELETE(): Promise<Response> {
  try {
    return Response.json({ purged: await purgeOldWindows() });
  } catch (error) {
    console.error('[connectors] purge failed', error);
    return Response.json({ error: 'Purge failed' }, { status: 500 });
  }
}
