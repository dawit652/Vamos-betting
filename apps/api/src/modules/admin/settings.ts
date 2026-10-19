import {
  StaffSettingKeySchema,
  StaffSettingsResponse,
  UpdateSettingRequest,
} from '@vamos/contracts';
import { getStaffSettings, updateStaffSetting } from '@vamos/db';
import type { FastifyInstance } from 'fastify';
import { notFound, parseInput } from '../../lib/errors';
import { staffActor } from '../../plugins/staff-session';
import { clearGameSettingsCache } from '../betting/service';
import { channelFlags } from '../channels/service';
import { inTx, wire } from './common';

/** The business settings (settings.view / settings.edit). */
export default async function adminSettingsRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;

  app.get('/admin/settings', { config: { staff: 'settings.view' } }, async () =>
    wire(StaffSettingsResponse, await getStaffSettings(deps.db)),
  );

  /**
   * The SMS / USSD channel switches, read-only: they live in the environment
   * (SMS_BETTING_ENABLED, USSD_ENABLED) and change only with a deployment,
   * once the regulator approves the channel.
   */
  app.get('/admin/channels', { config: { staff: 'settings.view' } }, async () =>
    channelFlags(deps),
  );

  /** The service validates the value (422 `invalid_setting`, details { key, issues }). */
  app.put<{ Params: { key: string } }>(
    '/admin/settings/:key',
    { config: { staff: 'settings.edit' } },
    async (request) => {
      const key = StaffSettingKeySchema.safeParse(request.params.key);
      if (!key.success) throw notFound('Setting');
      const input = parseInput(UpdateSettingRequest, request.body);
      const actor = staffActor(request);
      const view = await inTx(deps, async (tx) => {
        await updateStaffSetting(tx, { key: key.data, value: input.value, actor });
        return getStaffSettings(tx);
      });
      clearGameSettingsCache(deps.db);
      return wire(StaffSettingsResponse, view);
    },
  );
}
