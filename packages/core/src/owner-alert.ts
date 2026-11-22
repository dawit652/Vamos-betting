/**
 * Alerts to the owner's phone (plan task 1.11, docs/plans/hulusport-parity-plan.md 4.4). A person is
 * told, never waited for: an alert says WHAT WAS DONE ("Betting closed on ...", "Odds reads are
 * stopped ..."), never what to do. It is one short plain text, at most `OWNER_ALERT_MAX_LENGTH`
 * characters (one SMS), with no personal data: only source, institution and credit-API names and
 * counts, never a player, a phone number, an amount or a reference.
 *
 * `key` is the alarm's name plus its subject; the worker sends the same key at most once per
 * OWNER_ALERT_MIN_INTERVAL_MINUTES. Pure: no I/O.
 */

/** One SMS segment of plain text. */
export const OWNER_ALERT_MAX_LENGTH = 160;

/** A source's name is shown at most this long (the rest is cut with an ellipsis). */
const NAME_MAX_LENGTH = 40;

/** The alarms that raise an alert, with what each message needs. */
export type OwnerAlertInput =
  /** The result ladder's shadow recorder failed (it records only; results are unchanged). */
  | { alarm: 'ladder_shadow_failed' }
  /** A source's pages no longer parse as before, or its configuration is invalid. */
  | {
      alarm: 'source_broken';
      sourceId: string;
      sourceName: string;
      reason: 'shape' | 'invalid_config';
    }
  /** A source answers but has shown nothing new while listed matches ended. */
  | { alarm: 'source_stale'; sourceId: string; sourceName: string; daysUnchanged: number }
  /** The credit guard is in economy or minimal (a metered odds API). */
  | { alarm: 'budget_low'; creditKey: string }
  /** The credit guard stops reading: no credits left. */
  | { alarm: 'budget_exhausted'; creditKey: string }
  /** The last 24 hours of spending would outrun the remaining credits before the reset. */
  | { alarm: 'budget_projection'; creditKey: string; daysUntilEmpty: number }
  /** The odds API refused the key (HTTP 401). */
  | { alarm: 'unauthorized'; creditKey: string }
  /** A daily-limited API (API-Football) has under 10% of today's requests left. */
  | { alarm: 'rate_limit_low'; creditKey: string; remaining: number; limit: number }
  /** A request cost more credits than expected. */
  | { alarm: 'unexpected_cost'; creditKey: string; cost: number; expected: number }
  /** A credited SMS deposit is contradicted by the institution's receipt page. */
  | { alarm: 'sms_receipt_rejected'; smsId: string }
  /** The collection account's balance moved differently from what the SMS rail saw. */
  | {
      alarm: 'sms_balance_drift';
      institution: string;
      direction: 'credited_more_than_arrived' | 'missed_incoming';
    }
  /** A collection account's last known balance is below the withdrawals open bets are expected to cause. */
  | { alarm: 'payout_float_low'; institution: string }
  /** No SMS from the collection handset during active hours. */
  | { alarm: 'sms_gateway_silent' }
  /** One collection account's handset sent nothing while players wait on deposits to it. */
  | { alarm: 'sms_account_silent'; account: string }
  /** A collection handset's forwarder has sent no heartbeat for the alarm window (the phone may be off). */
  | { alarm: 'sms_handset_heartbeat_missed'; account: string }
  /** A collection handset reported a low battery and is not charging. */
  | { alarm: 'sms_handset_battery_low'; account: string }
  /** SMS waiting for staff: a long queue or an old item. */
  | { alarm: 'sms_review_backlog' }
  /** An approved manual payout has waited more than two hours. */
  | { alarm: 'manual_payout_waiting' }
  /** An operator claimed a manual payout over 30 minutes ago and has not settled, released or failed it. */
  | { alarm: 'manual_payout_claim_idle' }
  /** A collection account (where players send deposits) was added, approved, changed or deleted. */
  | {
      alarm: 'collection_account_changed';
      account: string;
      change: 'requested' | 'approved' | 'edited' | 'deleted';
    }
  /** The weekly market family job moved a family (plan task 2.5). */
  | {
      alarm: 'market_family_moved';
      family: string;
      move: 'suspend' | 'return' | 'off';
      week: string;
    }
  /**
   * A service Nahubet depends on (a payment provider, a feed, mr-x, mr-z) has been failing for
   * SERVICE_DOWN_AFTER_MS (docs/plans/counter-codes-and-deposit-recovery.md, G7).
   */
  | { alarm: 'service_down'; service: string; minutesDown: number; detail: string | null }
  /** It works again: once per incident (the key carries when it went down). */
  | { alarm: 'service_recovered'; service: string; minutesDown: number; downSinceMs: number }
  /**
   * An owner report failed one of its own checks (docs/plans/owner-reports.md): a closed day
   * changed after its close, or a day did not balance or roll forward when it was closed.
   */
  | { alarm: 'report_check_failed'; date: string; checks: readonly string[] };

export interface OwnerAlert {
  /** The alarm's name plus its subject, e.g. `source_broken|odds-api`. Stable per condition. */
  key: string;
  /** The text sent: at most OWNER_ALERT_MAX_LENGTH characters, one line. */
  message: string;
}

/** Control characters and line breaks become spaces; runs of spaces collapse; the ends are trimmed. */
function plain(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** `text` cut to `max` characters, the last three being dots when something was cut. */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max
    ? text
    : `${chars
        .slice(0, max - 3)
        .join('')
        .trimEnd()}...`;
}

/** A name as it is shown: plain text, cut to NAME_MAX_LENGTH; a stand-in when it is empty. */
function nameOf(name: string, standIn: string): string {
  const text = plain(name);
  return text.length === 0 ? standIn : clip(text, NAME_MAX_LENGTH);
}

const wholeNumber = (n: number, least: number): number =>
  Number.isFinite(n) ? Math.max(least, Math.round(n)) : least;

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** The subject part of a key: plain, no separator inside, bounded. */
const subjectOf = (value: string): string => clip(plain(value).replaceAll('|', '/'), 120);

function build(input: OwnerAlertInput): OwnerAlert {
  switch (input.alarm) {
    case 'ladder_shadow_failed':
      return {
        key: 'ladder_shadow_failed',
        message:
          'The result ladder shadow failed on this pass. Results and betting carry on as before; nothing was changed.',
      };
    case 'source_broken': {
      const name = nameOf(input.sourceName, 'A source');
      return {
        key: `source_broken|${subjectOf(input.sourceId)}`,
        message:
          input.reason === 'invalid_config'
            ? `${name}: its configuration is invalid, so it is not read. The other sources carry on.`
            : `${name}: its pages no longer read as before. Nothing from them is stored; the league runs on its other sources.`,
      };
    }
    case 'source_stale': {
      const name = nameOf(input.sourceName, 'A source');
      const days = wholeNumber(input.daysUnchanged, 1);
      return {
        key: `source_stale|${subjectOf(input.sourceId)}`,
        message: `${name} has shown nothing new for ${days} ${plural(days, 'day', 'days')}. It is marked stale; no result is settled from one source alone.`,
      };
    }
    case 'budget_low':
      return {
        key: `budget_low|${subjectOf(input.creditKey)}`,
        message:
          'Bookmaker odds credits are running low: odds are read less often to make them last.',
      };
    case 'budget_exhausted':
      return {
        key: `budget_exhausted|${subjectOf(input.creditKey)}`,
        message: 'Bookmaker odds credits are used up: odds reads are stopped until the 1st.',
      };
    case 'budget_projection': {
      const days = wholeNumber(input.daysUntilEmpty, 1);
      return {
        key: `budget_projection|${subjectOf(input.creditKey)}`,
        message: `Bookmaker odds credits would be used up in about ${days} ${plural(days, 'day', 'days')}, before the 1st. Reading carries on at the normal pace.`,
      };
    }
    case 'unauthorized':
      return {
        key: `unauthorized|${subjectOf(input.creditKey)}`,
        message: 'The bookmaker odds API refused our key: reads with that key are stopped.',
      };
    case 'rate_limit_low': {
      const remaining = wholeNumber(input.remaining, 0);
      const limit = wholeNumber(input.limit, 0);
      return {
        key: `rate_limit_low|${subjectOf(input.creditKey)}`,
        message: `The results API has ${remaining} of ${limit} requests left today. Reading carries on; the limit resets at midnight UTC.`,
      };
    }
    case 'unexpected_cost':
      return {
        key: `unexpected_cost|${subjectOf(input.creditKey)}`,
        message: `A bookmaker odds request cost ${wholeNumber(input.cost, 0)} credits instead of ${wholeNumber(input.expected, 0)}. Reading carries on.`,
      };
    case 'sms_receipt_rejected':
      // One key for every SMS (not one per SMS): a summary at most once per repeat window, never a
      // text per deposit.
      return {
        key: 'sms_receipt_rejected',
        message:
          "An SMS deposit contradicted by the institution's receipt was found: it stays credited and is held for staff on the SMS rail page.",
      };
    case 'sms_balance_drift': {
      const institution = nameOf(input.institution, 'The collection account');
      return {
        key: `sms_balance_drift|${subjectOf(input.institution)}|${input.direction}`,
        message:
          input.direction === 'credited_more_than_arrived'
            ? `The ${institution} balance moved less than we credited. Nothing was reversed; the gap is kept on the health panel.`
            : `The ${institution} balance moved more than the SMS we saw. Nothing was changed; the gap is kept on the health panel.`,
      };
    }
    case 'payout_float_low': {
      const institution = nameOf(input.institution, 'A collection account');
      return {
        key: `payout_float_low|${subjectOf(input.institution)}`,
        message: `The ${institution} balance is below the withdrawals the open bets are expected to cause. Payouts are not stopped; the forecast is on the health panel.`,
      };
    }
    case 'sms_gateway_silent':
      return {
        key: 'sms_gateway_silent',
        message:
          'No SMS came from the collection handset for 30 minutes. Deposits stay open and are credited when its SMS arrive.',
      };
    case 'sms_account_silent': {
      const account = nameOf(input.account, 'A collection account');
      return {
        key: `sms_account_silent|${subjectOf(input.account)}`,
        message: `No SMS came for the collection account ${account} for 30 minutes while players wait on deposits to it. Those deposits stay open and are credited when its SMS arrive.`,
      };
    }
    case 'sms_handset_heartbeat_missed': {
      const account = nameOf(input.account, 'A collection account');
      return {
        key: `sms_handset_heartbeat_missed|${subjectOf(input.account)}`,
        message: `The handset of the collection account ${account} has sent no heartbeat for a while, so it may be off or offline. Deposits stay open and are credited when its SMS arrive.`,
      };
    }
    case 'sms_handset_battery_low': {
      const account = nameOf(input.account, 'A collection account');
      return {
        key: `sms_handset_battery_low|${subjectOf(input.account)}`,
        message: `The handset of the collection account ${account} reports a low battery and is not charging. Deposits stay open and are credited when its SMS arrive.`,
      };
    }
    case 'sms_review_backlog':
      return {
        key: 'sms_review_backlog',
        message:
          'SMS deposits are waiting for staff. None is credited without a match; those deposits stay open.',
      };
    case 'manual_payout_waiting':
      return {
        key: 'manual_payout_waiting',
        message:
          'An approved manual payout has waited over 2 hours. It stays queued for an operator; nothing is paid without one.',
      };
    case 'manual_payout_claim_idle':
      return {
        // One text per interval whatever the number of idle claims: an operator who took a
        // batch of ten and is still paying them must not send ten texts.
        key: 'manual_payout_claim_idle',
        message:
          'A claimed manual payout has had no result for over 30 minutes. It stays with its operator; nothing was recorded or changed.',
      };
    case 'collection_account_changed': {
      const account = nameOf(input.account, 'A collection account');
      return {
        key: `collection_account_changed|${subjectOf(input.account)}|${input.change}`,
        message:
          input.change === 'requested'
            ? `A new collection account ${account} was added in the back office. Players are not shown it until a second person approves it.`
            : input.change === 'approved'
              ? `The collection account ${account} was approved in the back office. Players are now shown it for deposits.`
              : input.change === 'edited'
                ? `The name or hint of the collection account ${account} was changed in the back office. Its number stays the same.`
                : `The collection account ${account} was deleted in the back office. No new deposits go to it, and money already sent there is still credited.`,
      };
    }
    case 'service_down':
      return {
        key: `service_down|${input.service}`,
        message: `${clip(input.service, NAME_MAX_LENGTH)} is down for ${input.minutesDown} min${
          input.detail === null ? '' : `: ${input.detail}`
        }. Repeated every 15 min until it works again.`,
      };
    case 'report_check_failed':
      return {
        key: `report_check_failed|${input.date}`,
        message: `The report of ${input.date} failed its checks (${clip(input.checks.join(', '), 80)}). Open Reports in the back office.`,
      };
    case 'service_recovered':
      return {
        key: `service_recovered|${input.service}|${input.downSinceMs}`,
        message: `${clip(input.service, NAME_MAX_LENGTH)} works again, after ${input.minutesDown} min down.`,
      };
    case 'market_family_moved': {
      const family = nameOf(input.family, 'A market family');
      return {
        key: `market_family_moved|${subjectOf(input.family)}|${subjectOf(input.week)}`,
        message:
          input.move === 'suspend'
            ? `Market family ${family} kept less than its margin for 3 weeks: it is suspended. Its open bets stand.`
            : input.move === 'return'
              ? `Market family ${family} is offered again, 2 points of margin dearer.`
              : `Market family ${family} kept too little again after its return: it is off for good. Its open bets stand.`,
      };
    }
  }
}

const HOUR_MS = 3_600_000;

/**
 * Which alarms reach the owner's phone and Telegram, and how often at most (owner's rule, 20 Nov
 * 2026: "just notify when it's important", after alerts every few minutes about deposits and
 * withdrawals). `send: false` alarms stay log lines and back-office panels for staff. `repeatMs` is
 * the least time between two alerts of one key while the condition lasts (the configured
 * OWNER_ALERT_MIN_INTERVAL_MINUTES only ever lengthens it).
 */
export interface OwnerAlertRule {
  send: boolean;
  repeatMs: number;
  /** `repeatMs` exactly, even below OWNER_ALERT_MIN_INTERVAL_MINUTES (the owner's own rhythm). */
  exact?: boolean;
  /** Telegram only, never an SMS (frequent alerts would cost an SMS each). */
  telegramOnly?: boolean;
}

export const OWNER_ALERT_POLICY: Readonly<Record<OwnerAlertInput['alarm'], OwnerAlertRule>> = {
  // Money: deposits not crediting, contradicted or mismatched; withdrawals that cannot be paid or
  // wait too long; a change to where players send money.
  sms_gateway_silent: { send: true, repeatMs: 6 * HOUR_MS },
  sms_account_silent: { send: true, repeatMs: 6 * HOUR_MS },
  sms_receipt_rejected: { send: true, repeatMs: 24 * HOUR_MS },
  sms_balance_drift: { send: true, repeatMs: 24 * HOUR_MS },
  payout_float_low: { send: true, repeatMs: 12 * HOUR_MS },
  manual_payout_waiting: { send: true, repeatMs: 6 * HOUR_MS },
  collection_account_changed: { send: true, repeatMs: 0 },
  // Staff's daily work, on the SMS rail and manual payout pages: not texted.
  sms_handset_heartbeat_missed: { send: false, repeatMs: 0 },
  sms_handset_battery_low: { send: false, repeatMs: 0 },
  sms_review_backlog: { send: false, repeatMs: 0 },
  manual_payout_claim_idle: { send: false, repeatMs: 0 },
  // The odds sources and their paid credits (unchanged).
  ladder_shadow_failed: { send: true, repeatMs: 0 },
  source_broken: { send: true, repeatMs: 0 },
  source_stale: { send: true, repeatMs: 0 },
  budget_low: { send: true, repeatMs: 0 },
  budget_exhausted: { send: true, repeatMs: 0 },
  budget_projection: { send: true, repeatMs: 0 },
  unauthorized: { send: true, repeatMs: 0 },
  rate_limit_low: { send: true, repeatMs: 0 },
  unexpected_cost: { send: true, repeatMs: 0 },
  market_family_moved: { send: true, repeatMs: 0 },
  // Services down (owner, 21 Nov 2026, decision O4): Telegram every 15 minutes while it lasts,
  // then once "works again".
  service_down: { send: true, repeatMs: 15 * 60_000, exact: true, telegramOnly: true },
  service_recovered: { send: true, repeatMs: 0, telegramOnly: true },
  // Reports that do not check out (owner, 22 Nov 2026: reports never make a mistake): money.
  report_check_failed: { send: true, repeatMs: 6 * HOUR_MS },
};

/** Whether an alarm is texted at all, and the least time between two texts of one key. */
export function ownerAlertDelivery(
  input: OwnerAlertInput,
  configuredIntervalMs: number,
): { send: boolean; intervalMs: number; telegramOnly: boolean } {
  const policy = OWNER_ALERT_POLICY[input.alarm];
  return {
    send: policy.send,
    intervalMs:
      policy.exact === true ? policy.repeatMs : Math.max(configuredIntervalMs, policy.repeatMs),
    telegramOnly: policy.telegramOnly === true,
  };
}

/**
 * The owner alert for an alarm: a stable key and a short message of what was done. The message is
 * one line of at most OWNER_ALERT_MAX_LENGTH characters whatever the names in it.
 */
export function buildOwnerAlert(input: OwnerAlertInput): OwnerAlert {
  const { key, message } = build(input);
  return { key, message: clip(plain(message), OWNER_ALERT_MAX_LENGTH) };
}
