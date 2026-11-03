import type { FastifyInstance } from 'fastify';
import { staffSessionPlugin } from '../../plugins/staff-session';
import adminAuditRoutes from './audit';
import adminAuthRoutes from './auth';
import adminBetRoutes from './bets';
import { guardAdminRoutes } from './common';
import adminComplianceRoutes from './compliance';
import adminFeedRoutes from './feed';
import adminJackpotRoutes from './jackpots';
import adminPaymentRoutes from './payments';
import adminPlayerRoutes from './players';
import adminSettingsRoutes from './settings';
import adminTradingRoutes from './trading';

/**
 * The back office API (/admin/*, Phase 9). One encapsulated scope: the
 * staff session hook and the route guards apply here only, and every route
 * declares its access (`config.staff`), from which guardAdminRoutes attaches
 * the RBAC guard (a route without one refuses to start).
 */
export default async function adminRoutes(app: FastifyInstance): Promise<void> {
  // Called directly, not registered: its hook must cover this scope's routes.
  await staffSessionPlugin(app);
  guardAdminRoutes(app);
  await app.register(adminAuthRoutes);
  await app.register(adminPlayerRoutes);
  await app.register(adminTradingRoutes);
  await app.register(adminFeedRoutes);
  await app.register(adminBetRoutes);
  await app.register(adminPaymentRoutes);
  await app.register(adminJackpotRoutes);
  await app.register(adminSettingsRoutes);
  await app.register(adminAuditRoutes);
  await app.register(adminComplianceRoutes);
}
