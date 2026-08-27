import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { env } from '@/lib/env';
import * as schema from './schema';

/**
 * The database client, created on first use rather than on import.
 *
 * Laziness is load-bearing, not a nicety. `next build` imports every route
 * module to collect its configuration, so a connection opened at module scope
 * makes `DATABASE_URL` a *build-time* requirement — the build fails in CI, and
 * on any platform that builds an image before injecting runtime configuration.
 * Deferring it means a secret is only needed when a request actually arrives.
 *
 * The instance is cached on `globalThis` because Next.js hot-reloads modules in
 * development, which would otherwise leak a pool on every edit.
 */

type Database = ReturnType<typeof createDrizzle>;

const globalForDb = globalThis as unknown as {
  __agentSql?: postgres.Sql;
  __agentDb?: Database;
};

function createClient(): postgres.Sql {
  return postgres(env.databaseUrl, {
    max: env.isProduction ? 10 : 3,
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false,
  });
}

function createDrizzle(client: postgres.Sql) {
  return drizzle(client, { schema, casing: 'snake_case' });
}

function resolveClient(): postgres.Sql {
  if (globalForDb.__agentSql) return globalForDb.__agentSql;
  const client = createClient();
  globalForDb.__agentSql = client;
  return client;
}

function resolveDb(): Database {
  if (globalForDb.__agentDb) return globalForDb.__agentDb;
  const instance = createDrizzle(resolveClient());
  globalForDb.__agentDb = instance;
  return instance;
}

/**
 * Forward access to a lazily created instance.
 *
 * A proxy rather than a `getDb()` function so call sites stay `db.select(...)`.
 * Methods are bound to the real instance, because drizzle's builders rely on
 * their own `this`.
 *
 * The target is a function and there is an `apply` trap because postgres.js's
 * `sql` is itself callable — it is a tagged-template function, so
 * `sql\`select 1\`` has to work, not just `sql.end()`. A proxy over a plain
 * object is not callable, and the failure is a bare "client is not a function"
 * at the first raw query.
 */
function lazy<T extends object>(resolve: () => T): T {
  const target = function lazyTarget() {} as unknown as T;

  return new Proxy(target, {
    apply(_target, thisArg: unknown, args: unknown[]) {
      const instance = resolve() as unknown as (...values: unknown[]) => unknown;
      if (typeof instance !== 'function') {
        throw new TypeError('This lazy value is not callable');
      }
      return Reflect.apply(instance, thisArg, args);
    },
    get(_target, property) {
      const instance = resolve();
      const value = Reflect.get(instance, property) as unknown;
      return typeof value === 'function' ? (value as () => unknown).bind(instance) : value;
    },
    has(_target, property) {
      return Reflect.has(resolve(), property);
    },
    ownKeys() {
      return Reflect.ownKeys(resolve());
    },
    getOwnPropertyDescriptor(_target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(resolve(), property);
      // A proxy may not report a property as non-configurable when the target
      // does not have it, so the descriptor is relaxed.
      return descriptor === undefined ? undefined : { ...descriptor, configurable: true };
    },
  });
}

export const db: Database = lazy(resolveDb);

/**
 * The underlying client.
 *
 * Exported so a script can close the pool and let the process exit; application
 * code should use `db`.
 */
export const sql: postgres.Sql = lazy(resolveClient) as postgres.Sql;

export type { Database };
export { schema };
