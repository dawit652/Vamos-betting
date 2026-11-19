import { createHash } from 'node:crypto';
import { and, asc, eq, lt, or, isNull, sql } from 'drizzle-orm';
import { assertShopOperates, getShop, getStaffShop } from '../cashier/desk';
import { domainConflict, domainForbidden, domainNotFound, domainUnprocessable } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { adminUsers } from '../schema/accounts';
import { cashierShops } from '../schema/cashier';
import { shopDevices } from '../schema/devices';
import { agents } from '../schema/retail';
import { formatShopLabel } from '@vamos/core';

/**
 * Shop devices (docs/plans/agent-shops.md, phase 1b; owner, 19 Nov 2026: "registered devices only,
 * an admin approves each"). A cashier's device asks once (its random secret stays in the device's
 * cookie; only the SHA-256 is stored), an admin approves or revokes it, and the shop app signs a
 * cashier in only on an approved device of their own shop. Every decision is audited.
 */

export type ShopDevice = typeof shopDevices.$inferSelect;

export const SHOP_DEVICE_AUDIT = {
  requested: 'shop_device.requested',
  approved: 'shop_device.approved',
  revoked: 'shop_device.revoked',
} as const;

/** Requests waiting at one shop: more are refused (a stolen password cannot flood the list). */
export const MAX_PENDING_DEVICES_PER_SHOP = 5;
/** last_seen_at is written at most this often per device. */
export const DEVICE_SEEN_EVERY_MS = 5 * 60_000;

/** The stored form of a device secret (SHA-256, hex). */
export function hashDeviceSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** A device with its shop's printed number and name and who asked for it. */
export interface ShopDeviceRow extends ShopDevice {
  shopLabel: string;
  shopName: string;
  requestedByName: string;
}

/**
 * A cashier's device asks to be registered at the cashier's own shop. 403 `device_staff_only` for
 * anyone but an enabled cashier, 409 `shop_assignment_required` without a shop, 409
 * `shop_inactive` / `agent_blocked` for a shop that cannot work, 409 `too_many_device_requests`
 * when MAX_PENDING_DEVICES_PER_SHOP wait already, 422 `invalid_device_label`. Audited.
 */
export async function requestShopDevice(
  tx: DbTransaction,
  input: {
    staffId: string;
    label: string;
    secretHash: string;
    userAgent: string;
    now: Date;
    ip?: string | null;
  },
): Promise<ShopDevice> {
  const label = input.label.trim().replace(/\s+/g, ' ');
  if (label.length < 1 || label.length > 60) {
    throw domainUnprocessable('invalid_device_label', 'Name the device in 1 to 60 characters.');
  }
  const [staff] = await tx
    .select({ role: adminUsers.role, disabledAt: adminUsers.disabledAt })
    .from(adminUsers)
    .where(eq(adminUsers.id, input.staffId));
  if (!staff || staff.disabledAt !== null || staff.role !== 'cashier') {
    throw domainForbidden('device_staff_only', 'Only a cashier registers a shop device.');
  }
  const shopId = await getStaffShop(tx, input.staffId);
  if (shopId === null) {
    throw domainConflict(
      'shop_assignment_required',
      'An admin must first assign you to your shop.',
    );
  }
  const shop = await getShop(tx, shopId);
  if (shop === null) throw domainNotFound('Shop');
  assertShopOperates(shop);
  // The shop row is locked: two requests at once cannot both pass the pending limit.
  await tx
    .select({ id: cashierShops.id })
    .from(cashierShops)
    .where(eq(cashierShops.id, shopId))
    .for('update');
  const [waiting] = await tx
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(shopDevices)
    .where(and(eq(shopDevices.shopId, shopId), eq(shopDevices.status, 'pending')));
  if ((waiting?.n ?? 0) >= MAX_PENDING_DEVICES_PER_SHOP) {
    throw domainConflict(
      'too_many_device_requests',
      'Too many devices wait for approval at this shop: ask an admin.',
    );
  }
  const [device] = await tx
    .insert(shopDevices)
    .values({
      shopId,
      label,
      secretHash: input.secretHash,
      status: 'pending',
      requestedBy: input.staffId,
      requestedAt: input.now,
      userAgent: input.userAgent.slice(0, 300),
    })
    .returning();
  if (!device) throw new Error('shop_devices insert returned no row');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.staffId,
    action: SHOP_DEVICE_AUDIT.requested,
    targetType: 'shop_device',
    targetId: device.id,
    metadata: { shopId, label: shop.label, device: label },
    ip: input.ip ?? null,
  });
  return device;
}

async function lockDevice(tx: DbTransaction, deviceId: string): Promise<ShopDevice> {
  const [row] = await tx
    .select()
    .from(shopDevices)
    .where(eq(shopDevices.id, deviceId))
    .for('update');
  if (!row) throw domainNotFound('Device');
  return row;
}

/** An admin approves a waiting device (409 `device_not_pending` otherwise). Audited. */
export async function approveShopDevice(
  tx: DbTransaction,
  input: { deviceId: string; adminId: string; now: Date; ip?: string | null },
): Promise<ShopDevice> {
  const device = await lockDevice(tx, input.deviceId);
  if (device.status !== 'pending') {
    throw domainConflict('device_not_pending', 'This device is not waiting for approval.');
  }
  const [after] = await tx
    .update(shopDevices)
    .set({ status: 'approved', decidedBy: input.adminId, approvedAt: input.now })
    .where(eq(shopDevices.id, device.id))
    .returning();
  if (!after) throw domainNotFound('Device');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: SHOP_DEVICE_AUDIT.approved,
    targetType: 'shop_device',
    targetId: device.id,
    metadata: { shopId: device.shopId, device: device.label },
    ip: input.ip ?? null,
  });
  return after;
}

/**
 * An admin revokes a device (waiting or approved), with a reason of 3 to 500 characters: the shop
 * app stops accepting it at the next request. Already revoked: returned as it is. Audited.
 */
export async function revokeShopDevice(
  tx: DbTransaction,
  input: { deviceId: string; adminId: string; reason: string; now: Date; ip?: string | null },
): Promise<ShopDevice> {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw domainUnprocessable('invalid_reason', 'Give a reason of 3 to 500 characters.');
  }
  const device = await lockDevice(tx, input.deviceId);
  if (device.status === 'revoked') return device;
  const [after] = await tx
    .update(shopDevices)
    .set({
      status: 'revoked',
      decidedBy: input.adminId,
      revokedAt: input.now,
      revokedReason: reason,
    })
    .where(eq(shopDevices.id, device.id))
    .returning();
  if (!after) throw domainNotFound('Device');
  await writeAudit(tx, {
    actorType: 'admin',
    actorId: input.adminId,
    action: SHOP_DEVICE_AUDIT.revoked,
    targetType: 'shop_device',
    targetId: device.id,
    metadata: { shopId: device.shopId, device: device.label, reason },
    ip: input.ip ?? null,
  });
  return after;
}

/** The devices of an agent's shops: waiting first, then approved, then revoked; newest first. */
export async function listAgentDevices(
  exec: DbExecutor,
  agentId: string,
): Promise<ShopDeviceRow[]> {
  const rows = await exec
    .select({
      device: shopDevices,
      agentNumber: agents.number,
      shopNumber: cashierShops.number,
      shopName: cashierShops.name,
      requestedByName: adminUsers.displayName,
    })
    .from(shopDevices)
    .innerJoin(cashierShops, eq(cashierShops.id, shopDevices.shopId))
    .innerJoin(agents, eq(agents.id, cashierShops.agentId))
    .innerJoin(adminUsers, eq(adminUsers.id, shopDevices.requestedBy))
    .where(eq(cashierShops.agentId, agentId))
    .orderBy(
      sql`CASE ${shopDevices.status} WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END`,
      sql`${shopDevices.requestedAt} DESC`,
      asc(shopDevices.id),
    );
  return rows.map((row) => ({
    ...row.device,
    shopLabel: formatShopLabel(row.agentNumber, row.shopNumber),
    shopName: row.shopName,
    requestedByName: row.requestedByName,
  }));
}

/**
 * The approved device behind a secret, if it belongs to the staff member's own shop; null
 * otherwise (unknown secret, waiting or revoked device, another shop's device, no shop). The caller
 * also checks the shop and its agent (assertShopOperates) and the account.
 */
export async function findApprovedStaffDevice(
  exec: DbExecutor,
  input: { staffId: string; secretHash: string },
): Promise<ShopDevice | null> {
  const shopId = await getStaffShop(exec, input.staffId);
  if (shopId === null) return null;
  const [device] = await exec
    .select()
    .from(shopDevices)
    .where(
      and(
        eq(shopDevices.secretHash, input.secretHash),
        eq(shopDevices.shopId, shopId),
        eq(shopDevices.status, 'approved'),
      ),
    )
    .limit(1);
  return device ?? null;
}

/** Notes that the device was used (at most every DEVICE_SEEN_EVERY_MS). */
export async function touchShopDevice(
  exec: DbExecutor,
  deviceId: string,
  now: Date,
): Promise<void> {
  await exec
    .update(shopDevices)
    .set({ lastSeenAt: now })
    .where(
      and(
        eq(shopDevices.id, deviceId),
        or(
          isNull(shopDevices.lastSeenAt),
          lt(shopDevices.lastSeenAt, new Date(now.getTime() - DEVICE_SEEN_EVERY_MS)),
        ),
      ),
    );
}
