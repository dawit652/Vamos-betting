import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../deps';
import adminRoutes from './admin/routes';
import authRoutes from './auth/routes';
import bettingRoutes from './betting/routes';
import catalogRoutes from './catalog/routes';
import devChannelRoutes, { devChannelsEnabled } from './channels/dev-routes';
import channelRoutes from './channels/routes';
import devRoutes, { devInboxEnabled } from './dev/routes';
import devJackpotRoutes, { devJackpotsEnabled } from './jackpots/dev-routes';
import jackpotRoutes from './jackpots/routes';
import kycRoutes from './kyc/routes';
import meRoutes from './me/routes';
import devPaymentRoutes, { demoPhoneEnabled } from './payments/dev-routes';
import devSmsRoutes, { devSmsEnabled } from './payments/dev-sms';
import paymentRoutes from './payments/routes';
import rgRoutes from './rg/routes';
import userStreamRoutes from './stream/routes';
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
  await app.register(userStreamRoutes);
  await app.register(paymentRoutes);
  await app.register(jackpotRoutes);
  // SMS / USSD aggregator routes: registered only while their flag is on (else 404).
  await app.register(channelRoutes);
  // The back office: staff sessions and RBAC of their own (plugins/staff-session.ts).
  await app.register(adminRoutes);
  if (devInboxEnabled(deps)) {
    await app.register(devRoutes);
  }
  // DEMO ONLY: the phone simulator (demo + mock provider, production demos included) and, outside
  // production, the stand-in back office.
  if (demoPhoneEnabled(deps)) {
    await app.register(devPaymentRoutes);
  }
  // DEV ONLY: the SMS rail simulator (demo + simulated rail, not production).
  if (devSmsEnabled(deps)) {
    await app.register(devSmsRoutes);
  }
  // DEV ONLY: quick jackpot rounds for e2e and demos (demo mode, not production).
  if (devJackpotsEnabled(deps)) {
    await app.register(devJackpotRoutes);
  }
  // DEV ONLY: the SMS / USSD simulator (demo mode, not production).
  if (devChannelsEnabled(deps)) {
    await app.register(devChannelRoutes);
  }
}
