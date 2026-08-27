import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { env } from '@/lib/env';
import * as schema from './schema';

/**
 * A single pooled client per process.
 *
 * Next.js hot-reloads modules in development, which would otherwise leak a new
 * pool on every edit, so the client is cached on `globalThis`.
 */
const globalForDb = globalThis as unknown as {
  __agentSql?: postgres.Sql;
};

function createClient(): postgres.Sql {
  return postgres(env.databaseUrl, {
    max: env.isProduction ? 10 : 3,
    idle_timeout: 20,
    connect_timeout: 15,
    // Route timestamps through as-is; Drizzle handles the mapping.
    prepare: false,
  });
}

export const sql: postgres.Sql = globalForDb.__agentSql ?? createClient();

if (!env.isProduction) {
  globalForDb.__agentSql = sql;
}

export const db = drizzle(sql, { schema, casing: 'snake_case' });

export type Database = typeof db;
export { schema };
