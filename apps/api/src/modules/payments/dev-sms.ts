import { randomInt } from 'node:crypto';
import { DevSmsRequest, type DevSmsResponse } from '@vamos/contracts';
import { santimToBirrString } from '@vamos/core';
import { getDepositIntent, getPayout, ingestSms, SMS_PROVIDER, withTxRetry } from '@vamos/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDeps } from '../../deps';
import { clientAddressKey } from '../../lib/client-address';
import { badRequest, notFound, parseInput } from '../../lib/errors';
import { requireUser } from '../../plugins/session';
import { parseId } from './service';
import { smsProviderOf } from './smsrail';
import { depositView } from './views';

/**
 * The dev SMS simulator exists only for the simulated SMS rail: demo mode,
 * `sms` enabled with SMS_RAIL_MODE=simulated and NODE_ENV other than
 * production. The live rail is fed only by the collection handset.
 */
export function devSmsEnabled(deps: Pick<AppDeps, 'config' | 'payments'>): boolean {
  return (
    deps.config.mode === 'demo' &&
    deps.config.nodeEnv !== 'production' &&
    smsProviderOf(deps)?.mode === 'simulated'
  );
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A reference shaped like the institutions' ones (SIM + 7 characters). */
function simulatedReference(): string {
  let out = 'SIM';
  for (let i = 0; i < 7; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** dd/mm/yyyy at h:mm:ss AM in EAT, as the institutions write it. */
function eatStamp(now: Date): { date: string; time: string } {
  const eat = new Date(now.getTime() + 3 * 60 * 60_000);
  const dd = String(eat.getUTCDate()).padStart(2, '0');
  const mm = String(eat.getUTCMonth() + 1).padStart(2, '0');
  const h24 = eat.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const min = String(eat.getUTCMinutes()).padStart(2, '0');
  const sec = String(eat.getUTCSeconds()).padStart(2, '0');
  return {
    date: `${dd}/${mm}/${eat.getUTCFullYear()}`,
    time: `${h12}:${min}:${sec} ${h24 < 12 ? 'AM' : 'PM'}`,
  };
}

/** The confirmation a collection account receives for an incoming transfer. */
export function simulatedCreditSms(input: {
  institution: string;
  amount: bigint;
  payerPhone: string | null;
  reference: string;
  now: Date;
}): { sender: string; text: string } {
  const { date, time } = eatStamp(input.now);
  const birr = santimToBirrString(input.amount);
  if (input.institution === 'cbe') {
    return {
      sender: 'CBE',
      text: `Dear Customer, You have received ETB ${birr} from DEMO PAYER on ${date}. Ref No ${input.reference}`,
    };
  }
  const from =
    input.payerPhone === null ? 'DEMO PAYER' : `DEMO PAYER (${input.payerPhone.slice(1)})`;
  return {
    sender: 'telebirr',
    text: `Dear CUSTOMER, you have received ETB ${birr} from ${from} on ${date} at ${time}. Your transaction number is ${input.reference}.`,
  };
}

/** The confirmation a collection account receives for an outgoing transfer (a manual payout). */
export function simulatedDebitSms(input: {
  amount: bigint;
  toPhone: string;
  reference: string;
  now: Date;
}): { sender: string; text: string } {
  const { date, time } = eatStamp(input.now);
  return {
    sender: 'telebirr',
    text: `Dear CUSTOMER, you have transferred ETB ${santimToBirrString(input.amount)} to DEMO PLAYER (${input.toPhone.slice(1)}) on ${date} at ${time}. Your transaction number is ${input.reference}.`,
  };
}

/**
 * DEV ONLY – not part of the product.
 *
 * - POST /dev/payments/sms (player session): the bank of the signed-in
 *   player "sends" the confirmation SMS of their own open SMS deposit, fed
 *   through ingestSms exactly as the gateway's would be;
 * - POST /dev/payments/sms/outgoing/:payoutId (no session: it plays the
 *   operator's collection handset): the outgoing confirmation of a manual
 *   payout to a wallet, which proposes it as that payout's proof.
 */
export default async function devSmsRoutes(app: FastifyInstance): Promise<void> {
  const { deps } = app;
  if (!devSmsEnabled(deps)) return;
  const rateLimit = {
    rateLimit: {
      max: 60,
      timeWindow: 60_000,
      keyGenerator: (request: FastifyRequest) => `dev-sms|${clientAddressKey(request.ip)}`,
    },
  };

  app.post(
    '/dev/payments/sms',
    { preHandler: app.requireAuth, config: rateLimit },
    async (request): Promise<DevSmsResponse> => {
      const input = parseInput(DevSmsRequest, request.body);
      const user = requireUser(request);
      const intent = await getDepositIntent(deps.db, parseId(input.depositId, 'Deposit'));
      if (intent === null || intent.provider !== SMS_PROVIDER || intent.userId !== user.id) {
        throw notFound('Deposit');
      }
      const provider = smsProviderOf(deps);
      // The account the server gave the deposit is the one the player pays (the first account
      // when the deposit names none, or the one at the institution the caller asked for).
      const assigned = provider?.collectionAccounts.find((a) => a.id === intent.collectionAccount);
      const institution =
        input.institution ??
        assigned?.institution ??
        provider?.collectionAccounts[0]?.institution ??
        'telebirr';
      const paidAccount =
        assigned?.institution === institution
          ? assigned
          : provider?.collectionAccounts.find((a) => a.institution === institution);
      if (paidAccount === undefined) {
        throw badRequest('unknown_institution', 'No collection account at that institution.');
      }
      const amount =
        input.variant === 'round' ? (intent.requestedAmount ?? intent.amount) : intent.amount;
      const payerPhone = input.variant === 'other_phone' ? '+251977000000' : user.phone;
      const sms = simulatedCreditSms({
        institution,
        amount,
        payerPhone,
        reference: simulatedReference(),
        now: deps.clock(),
      });
      const result = await withTxRetry(deps.db, (tx) =>
        ingestSms(tx, {
          source: 'simulator',
          collectionAccount: paidAccount.id,
          sender: sms.sender,
          text: sms.text,
          now: deps.clock(),
        }),
      );
      const after = await getDepositIntent(deps.db, intent.id);
      if (after === null) throw notFound('Deposit');
      return { outcome: result.outcome, text: sms.text, deposit: depositView(after) };
    },
  );

  app.post<{ Params: { payoutId: string } }>(
    '/dev/payments/sms/outgoing/:payoutId',
    { config: rateLimit },
    async (request) => {
      const payout = await getPayout(deps.db, parseId(request.params.payoutId, 'Withdrawal'));
      if (payout === null || !payout.manual || payout.destinationAccount === null) {
        throw notFound('Withdrawal');
      }
      if (!payout.destinationAccount.startsWith('+251')) {
        throw badRequest('not_a_wallet_payout', 'The simulator only sends wallet confirmations.');
      }
      const sms = simulatedDebitSms({
        amount: payout.amount,
        toPhone: payout.destinationAccount,
        reference: simulatedReference(),
        now: deps.clock(),
      });
      const result = await withTxRetry(deps.db, (tx) =>
        ingestSms(tx, {
          source: 'simulator',
          sender: sms.sender,
          text: sms.text,
          now: deps.clock(),
        }),
      );
      return { outcome: result.outcome, text: sms.text, smsId: result.sms.id };
    },
  );
}
