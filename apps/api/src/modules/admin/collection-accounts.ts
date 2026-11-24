import {
  CollectionAccountListResponse,
  CollectionAccountResponse,
  CreateCollectionAccountRequest,
  UpdateCollectionAccountRequest,
} from '@vamos/contracts';
import { INSTITUTIONS, institutionById } from '@vamos/core';
import {
  decideCollectionAccount,
  deleteCollectionAccount,
  editCollectionAccount,
  listCollectionAccounts,
  requestCollectionAccount,
  syncRailAccounts,
  type CollectionAccountRow,
  type DbExecutor,
} from '@vamos/db';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../deps';
import { notFound, parseInput } from '../../lib/errors';
import { staffActor } from '../../plugins/staff-session';
import { smsProviderOf } from '../payments/smsrail';
import { inTx, parseUuid, wire } from './common';

/**
 * The SMS rail's collection accounts (where players send deposits) in the back office: an admin
 * adds, edits and deletes them (settings.edit); a second person approves or rejects a new one
 * (withdrawals.approve, never who added it) before players are shown it. The money rules are in
 * @vamos/db (collectionaccounts.ts).
 */

function view(row: CollectionAccountRow) {
  return {
    id: row.id,
    accountId: row.accountId,
    institution: row.institution,
    institutionName: institutionById(row.institution)?.name ?? row.institution,
    account: row.account,
    name: row.name,
    hint: row.hint,
    status: row.status,
    createdBy: row.createdBy,
    createdByName: row.createdByName,
    createdAt: row.createdAt,
    decidedBy: row.decidedBy,
    decidedByName: row.decidedByName,
    decidedAt: row.decidedAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/** The holder name every account must have: the operator's legal name, in licensed mode. */
export function requiredHolderName(deps: Pick<AppDeps, 'config'>): string | null {
  if (deps.config.mode !== 'licensed') return null;
  const legal = deps.config.payments.sms.operatorLegalName?.trim();
  return legal ? legal : null;
}

async function rowOf(exec: DbExecutor, id: string): Promise<CollectionAccountRow> {
  const [row] = await listCollectionAccounts(exec, { id });
  if (row === undefined) throw notFound('Collection account');
  return row;
}

export default async function adminCollectionAccountRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;
  type IdParams = { Params: { id: string } };

  /** After a change this process uses the new list at once; the others within seconds. */
  const reload = async () => {
    const provider = smsProviderOf(deps);
    if (provider === null) return;
    try {
      await syncRailAccounts(deps.db, provider, deps.clock());
    } catch (error) {
      app.log.warn({ err: error }, 'collection accounts: reload after a change failed');
    }
  };

  app.get('/admin/collection-accounts', { config: { staff: 'sms.review' } }, async () => {
    // The first reload of a process fills an empty list with SMS_COLLECTION_ACCOUNTS.
    await reload();
    const accounts = await listCollectionAccounts(deps.db);
    return wire(CollectionAccountListResponse, {
      accounts: accounts.map(view),
      institutions: INSTITUTIONS.map((spec) => ({ id: spec.id, name: spec.name, kind: spec.kind })),
      requiredName: requiredHolderName(deps),
      railEnabled: smsProviderOf(deps) !== null,
      operatingMode: deps.config.mode,
    });
  });

  app.post(
    '/admin/collection-accounts',
    { config: { staff: 'settings.edit' } },
    async (request, reply) => {
      const input = parseInput(CreateCollectionAccountRequest, request.body);
      const actor = staffActor(request);
      const row = await inTx(deps, async (tx) => {
        const made = await requestCollectionAccount(tx, {
          institution: input.institution,
          account: input.account,
          name: input.name,
          hint: input.hint ?? null,
          legalName: requiredHolderName(deps),
          adminId: actor.adminId,
          now: deps.clock(),
          ip: actor.ip ?? null,
          ownerAlerts: deps.config.ownerAlerts,
        });
        return rowOf(tx, made.id);
      });
      reply.code(201);
      return wire(CollectionAccountResponse, { account: view(row), changed: true });
    },
  );

  app.patch<IdParams>(
    '/admin/collection-accounts/:id',
    { config: { staff: 'settings.edit' } },
    async (request) => {
      const id = parseUuid(request.params.id, 'Collection account');
      const input = parseInput(UpdateCollectionAccountRequest, request.body);
      const actor = staffActor(request);
      const result = await inTx(deps, async (tx) => {
        const edited = await editCollectionAccount(tx, {
          id,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.hint === undefined ? {} : { hint: input.hint }),
          legalName: requiredHolderName(deps),
          adminId: actor.adminId,
          now: deps.clock(),
          ip: actor.ip ?? null,
          ownerAlerts: deps.config.ownerAlerts,
        });
        return { row: await rowOf(tx, id), changed: edited.changed };
      });
      if (result.changed) await reload();
      return wire(CollectionAccountResponse, {
        account: view(result.row),
        changed: result.changed,
      });
    },
  );

  app.delete<IdParams>(
    '/admin/collection-accounts/:id',
    { config: { staff: 'settings.edit' } },
    async (request) => {
      const id = parseUuid(request.params.id, 'Collection account');
      const actor = staffActor(request);
      const result = await inTx(deps, async (tx) => {
        const deleted = await deleteCollectionAccount(tx, {
          id,
          adminId: actor.adminId,
          now: deps.clock(),
          ip: actor.ip ?? null,
          ownerAlerts: deps.config.ownerAlerts,
        });
        return { row: await rowOf(tx, id), changed: deleted.changed };
      });
      if (result.changed) await reload();
      return wire(CollectionAccountResponse, {
        account: view(result.row),
        changed: result.changed,
      });
    },
  );

  for (const decision of ['approve', 'reject'] as const) {
    app.post<IdParams>(
      `/admin/collection-accounts/:id/${decision}`,
      { config: { staff: 'withdrawals.approve' } },
      async (request) => {
        const id = parseUuid(request.params.id, 'Collection account');
        const actor = staffActor(request);
        const result = await inTx(deps, async (tx) => {
          const decided = await decideCollectionAccount(tx, {
            id,
            decision,
            adminId: actor.adminId,
            now: deps.clock(),
            ip: actor.ip ?? null,
            ownerAlerts: deps.config.ownerAlerts,
          });
          return { row: await rowOf(tx, id), changed: decided.changed };
        });
        if (result.changed && decision === 'approve') await reload();
        return wire(CollectionAccountResponse, {
          account: view(result.row),
          changed: result.changed,
        });
      },
    );
  }
}
