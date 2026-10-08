import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../deps';
import authRoutes from './auth/routes';
import devRoutes, { devInboxEnabled } from './dev/routes';
import kycRoutes from './kyc/routes';
import meRoutes from './me/routes';
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
  if (devInboxEnabled(deps)) {
    await app.register(devRoutes);
  }
}
