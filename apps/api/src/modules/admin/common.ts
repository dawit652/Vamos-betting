import type { StaffPermission } from '@vamos/contracts';
import {
  LIVE_CHANNEL,
  toJsonSafe,
  withTxRetry,
  type DbTransaction,
  type LiveMessage,
} from '@vamos/db';
import type { FastifyInstance, onRouteHookHandler, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../deps';
import { notFound } from '../../lib/errors';
import { requirePermission, requireStaffSession } from '../../plugins/staff-session';

/**
 * Who may call an /admin route: `public` (sign-in only), `session` (any
 * signed-in staff member) or the permission of the RBAC matrix
 * (@vamos/contracts PERMISSION_ROLES).
 */
export type StaffRouteAccess = 'public' | 'session' | StaffPermission;

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Required on every /admin route: the guard is attached from it (see guardAdminRoutes). */
    staff?: StaffRouteAccess;
  }
}

export interface AdminRouteInfo {
  method: string;
  url: string;
  access: StaffRouteAccess;
}

/** The /admin routes of each app (keyed by its deps), for tests that walk the whole surface. */
const adminRoutes = new WeakMap<AppDeps, AdminRouteInfo[]>();

/** Every /admin route of the app built with `deps`, with its access rule. */
export function listAdminRoutes(deps: AppDeps): readonly AdminRouteInfo[] {
  return adminRoutes.get(deps) ?? [];
}

/**
 * onRoute hook of the /admin scope: attaches the guard named by
 * `config.staff` in front of the route's own preHandlers, and refuses to
 * start when a route names none (fail closed: no /admin route is reachable
 * by accident without a staff session).
 */
export function guardAdminRoutes(app: FastifyInstance): void {
  const registry: AdminRouteInfo[] = [];
  adminRoutes.set(app.deps, registry);
  const hook: onRouteHookHandler = (route) => {
    const access = route.config?.staff;
    if (access === undefined) {
      throw new Error(`admin route ${String(route.method)} ${route.url} declares no config.staff`);
    }
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method !== 'HEAD') registry.push({ method, url: route.url, access });
    }
    if (access === 'public') return;
    const guard: preHandlerHookHandler =
      access === 'session' ? requireStaffSession : requirePermission(access);
    const existing = route.preHandler;
    route.preHandler =
      existing === undefined
        ? [guard]
        : [guard, ...(Array.isArray(existing) ? existing : [existing])];
  };
  app.addHook('onRoute', hook);
}

/** The wire form of a service result, checked against (and limited to) its contract schema. */
export function wire<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  return schema.parse(toJsonSafe(value));
}

const Uuid = z.uuid();

/** A UUID path parameter; anything else is a 404 for `what`. */
export function parseUuid(id: string, what: string): string {
  if (!Uuid.safeParse(id).success) throw notFound(what);
  return id;
}

/** Runs a back-office change in its own transaction (retried on deadlocks and serialization failures). */
export function inTx<T>(deps: AppDeps, fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
  return withTxRetry(deps.db, fn);
}

/**
 * Publishes live deltas after the change that produced them committed. A
 * failure is logged, not thrown: the change is durable and clients catch up
 * on their next fetch.
 */
export async function publishLive(
  app: FastifyInstance,
  messages: readonly LiveMessage[],
): Promise<void> {
  if (messages.length === 0) return;
  const channel = app.deps.liveChannel ?? LIVE_CHANNEL;
  try {
    const pipeline = app.deps.redis.pipeline();
    for (const message of messages) pipeline.publish(channel, JSON.stringify(message));
    const results = await pipeline.exec();
    for (const [error] of results ?? []) {
      if (error) throw error;
    }
  } catch (error) {
    app.log.warn({ err: error, count: messages.length }, 'publishing live deltas failed');
  }
}

/** A page query's optional `from`/`to` ISO strings as Dates. */
export function optionalDate(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}
