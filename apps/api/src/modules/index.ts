import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../deps';
import authRoutes from './auth/routes';
import bettingRoutes from './betting/routes';
import catalogRoutes from './catalog/routes';
import devRoutes, { devInboxEnabled } from './dev/routes';
import kycRoutes from './kyc/routes';
import meRoutes from './me/routes';
import devPaymentRoutes, { devPaymentsEnabled } from './payments/dev-routes';
import paymentRoutes from './payments/routes';
import rgRoutes from './rg/routes';
import walletRoutes from './wallet/routes';

/**
 * Registers the feature route plugins in a fixed order. Each plugin declares
 * full paths and reads its dependencies from `app.deps`.
 */
export async function registerModules(app: FastifyInstance, deps: AppDeps): Promise<void> {
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(kycRoutes);
  await app.register(rgRoutes);
  await app.register(walletRoutes);
  await app.register(catalogRoutes);
  await app.register(bettingRoutes);
  await app.register(paymentRoutes);
  if (devInboxEnabled(deps)) {
    await app.register(devRoutes);
  }
  // DEV ONLY: the phone simulator and the stand-in back office (demo + mock provider, not production).
  if (devPaymentsEnabled(deps)) {
    await app.register(devPaymentRoutes);
  }
}
