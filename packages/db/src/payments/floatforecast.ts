import { forecastPayoutFloat, type FloatForecast, type FloatForecastRules } from '@vamos/core';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { DbExecutor } from '../ledger/types';
import { betLegs, bets } from '../schema/betting';
import { events } from '../schema/catalog';
import { receivedSms } from '../schema/smsrail';

/**
 * Read-only inputs of the payout float forecast (plan task C10). Nothing here writes: it only
 * SELECTs the open bets and the balances the collection handsets reported.
 */

export interface OpenBetPayout {
  /** Santim: the net payout the bet pays if it wins. */
  potentialNetPayout: bigint;
  /** The start of the latest-starting event among the bet's legs. */
  lastEventStart: Date;
}

/** Hard cap on the rows read; an exposure this large is far beyond the float anyway. */
const MAX_OPEN_BETS = 200_000;

/** Open (and live-pending) bets with what they could pay and when their last event starts. */
export async function listOpenBetPayouts(exec: DbExecutor): Promise<OpenBetPayout[]> {
  const rows = await exec
    .select({
      potentialNetPayout: bets.potentialNetPayout,
      lastEventStart: sql<Date>`max(${events.startTime})`,
    })
    .from(bets)
    .innerJoin(betLegs, eq(betLegs.betId, bets.id))
    .innerJoin(events, eq(events.id, betLegs.eventId))
    .where(inArray(bets.status, ['open', 'pending_acceptance']))
    .groupBy(bets.id)
    .limit(MAX_OPEN_BETS);
  return rows.map((row) => ({
    potentialNetPayout: row.potentialNetPayout,
    lastEventStart: new Date(row.lastEventStart),
  }));
}

export interface LastKnownBalance {
  institution: string;
  /** Santim: the balance in the newest message of the handset that reported one. */
  balance: bigint;
  /** When that balance was reported (the message's own time, else when it arrived). */
  at: Date;
}

/**
 * The latest balance per institution, from messages the gateway forwarded (or the dev simulator);
 * a pasted or receipt-sourced row is never a balance observation (as in listBalanceObservations).
 */
export async function listLastKnownBalances(exec: DbExecutor): Promise<LastKnownBalance[]> {
  const when = sql<Date>`coalesce(${receivedSms.occurredAt}, ${receivedSms.receivedAt})`;
  const rows = await exec
    .selectDistinctOn([receivedSms.institution], {
      institution: receivedSms.institution,
      balance: receivedSms.balance,
      at: when,
    })
    .from(receivedSms)
    .where(
      and(
        isNotNull(receivedSms.institution),
        isNotNull(receivedSms.balance),
        inArray(receivedSms.source, ['gateway', 'simulator']),
      ),
    )
    .orderBy(receivedSms.institution, desc(when), desc(receivedSms.receivedAt));
  return rows.flatMap((row) =>
    row.institution === null || row.balance === null
      ? []
      : [{ institution: row.institution, balance: row.balance, at: new Date(row.at) }],
  );
}

export interface FloatForecastReport {
  forecast: FloatForecast;
  balances: LastKnownBalance[];
}

/** The forecast of the next hours and the last known balances, for the health panel and the alarm. */
export async function loadFloatForecast(
  exec: DbExecutor,
  options: { now: Date; rules: FloatForecastRules },
): Promise<FloatForecastReport> {
  const [openBets, balances] = await Promise.all([
    listOpenBetPayouts(exec),
    listLastKnownBalances(exec),
  ]);
  return { forecast: forecastPayoutFloat(openBets, options.now, options.rules), balances };
}
