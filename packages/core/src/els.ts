import { businessDateOf, isBusinessDate } from './businessday';

/**
 * Records of the regulator (Ethiopian Lottery Service) transaction stream,
 * built from outbox events (pure). One record per reportable event, written
 * as one line of canonical JSON (keys sorted, no spaces).
 *
 * Data minimisation (Ethiopia's Personal Data Protection Proclamation): a
 * record carries the player's pseudonymous id (`playerRef`, the internal
 * account UUID, which says nothing about the person without our database)
 * and amounts in santim. Names, phone numbers, ID documents, addresses and
 * IP addresses are never copied: each event type has a whitelist of fields
 * below and anything else in the payload is dropped.
 */

export const ELS_RECORD_SCHEMA = 'vamos.els.v1';

/** Outbox type of a finalised daily summary (written by the daily summary service). */
export const DAILY_SUMMARY_FINALIZED = 'compliance.daily_summary_finalized';

type ScalarKind = 'id' | 'text' | 'santim' | 'int' | 'intText' | 'bool' | 'datetime' | 'date';
type FieldSpec =
  | readonly [name: string, kind: ScalarKind]
  | readonly [name: string, kind: 'list' | 'object', fields: readonly FieldSpec[]];

const SETTLEMENT_FIELDS: readonly FieldSpec[] = [
  ['status', 'text'],
  ['grossPayout', 'santim'],
  ['taxAmount', 'santim'],
  ['netPayout', 'santim'],
];

const BET_REF: readonly FieldSpec[] = [
  ['betId', 'id'],
  ['shortId', 'text'],
];

/** The whitelisted payload fields of each reportable outbox type. */
export const ELS_EVENT_FIELDS: Readonly<Record<string, readonly FieldSpec[]>> = {
  'bet.placed': [
    ...BET_REF,
    ['status', 'text'],
    ['channel', 'text'],
    ['stake', 'santim'],
    ['totalOddsMilli', 'intText'],
    ['potentialNetPayout', 'santim'],
    ['acceptAfter', 'datetime'],
    [
      'legs',
      'list',
      [
        ['eventId', 'id'],
        ['selectionId', 'id'],
        ['oddsMilli', 'int'],
        ['isLive', 'bool'],
      ],
    ],
  ],
  'bet.accepted': [
    ...BET_REF,
    [
      'oddsChanged',
      'list',
      [
        ['selectionId', 'id'],
        ['from', 'int'],
        ['to', 'int'],
      ],
    ],
  ],
  'bet.rejected': [...BET_REF, ['reason', 'text'], ['refund', 'santim']],
  'bet.settled': [
    ...BET_REF,
    ['status', 'text'],
    ['version', 'int'],
    ['stake', 'santim'],
    ['grossPayout', 'santim'],
    ['taxAmount', 'santim'],
    ['netPayout', 'santim'],
    ['corrected', 'bool'],
    ['previous', 'object', SETTLEMENT_FIELDS],
  ],
  'bet.cashed_out': [
    ...BET_REF,
    ['stake', 'santim'],
    ['quotedGross', 'santim'],
    ['gross', 'santim'],
    ['tax', 'santim'],
    ['net', 'santim'],
    ['cashedOutAt', 'datetime'],
  ],
  'bet.reopened': [...BET_REF, ['version', 'int'], ['previous', 'object', SETTLEMENT_FIELDS]],
  'jackpot.entered': [
    ['entryId', 'id'],
    ['roundId', 'id'],
    ['templateCode', 'text'],
    ['combinations', 'int'],
    ['cost', 'santim'],
    ['channel', 'text'],
  ],
  'jackpot.settled': [
    ['entryId', 'id'],
    ['roundId', 'id'],
    ['templateCode', 'text'],
    ['status', 'text'],
    ['cost', 'santim'],
    ['gross', 'santim'],
    ['tax', 'santim'],
    ['net', 'santim'],
    ['refund', 'santim'],
    ['bestCorrect', 'int'],
  ],
  'payment.deposit_succeeded': [
    ['intentId', 'id'],
    ['provider', 'text'],
    ['amount', 'santim'],
    ['providerRef', 'text'],
  ],
  'payment.withdrawal_paid': [
    ['payoutId', 'id'],
    ['provider', 'text'],
    ['amount', 'santim'],
    ['providerRef', 'text'],
  ],
  [DAILY_SUMMARY_FINALIZED]: [
    ['businessDate', 'date'],
    ['version', 'int'],
    ['windowStart', 'datetime'],
    ['windowEnd', 'datetime'],
    ['turnover', 'santim'],
    ['betStakes', 'santim'],
    ['betCount', 'int'],
    ['jackpotStakes', 'santim'],
    ['jackpotEntryCount', 'int'],
    ['payouts', 'santim'],
    ['wonPayouts', 'santim'],
    ['cashOuts', 'santim'],
    ['refunds', 'santim'],
    ['jackpotPrizes', 'santim'],
    ['ggr', 'santim'],
    ['taxWithheld', 'santim'],
    ['bonuses', 'santim'],
    ['deposits', 'santim'],
    ['depositCount', 'int'],
    ['withdrawals', 'santim'],
    ['withdrawalCount', 'int'],
    ['activePlayers', 'int'],
    ['commissionRateBps', 'int'],
    ['commissionDue', 'santim'],
    ['hash', 'text'],
  ],
};

/** The outbox types reported to ELS (the dispatcher's `els` queue). */
export const ELS_REPORTABLE_TYPES: readonly string[] = Object.keys(ELS_EVENT_FIELDS);

export function isElsReportable(type: string): boolean {
  return Object.hasOwn(ELS_EVENT_FIELDS, type);
}

export type ElsValue = string | number | boolean | null | ElsValue[] | { [key: string]: ElsValue };

export interface ElsRecord {
  schema: typeof ELS_RECORD_SCHEMA;
  /** The outbox row id (decimal string): the record's identity, unique in the stream. */
  outboxId: string;
  type: string;
  /** ISO-8601 UTC time the event was recorded. */
  occurredAt: string;
  /** Business date (Africa/Addis_Ababa) of occurredAt. */
  businessDate: string;
  /** The player's pseudonymous id (account UUID), or null (e.g. a daily summary). */
  playerRef: string | null;
  refType: string;
  refId: string;
  data: { [key: string]: ElsValue };
}

const MAX_TEXT = 200;
const MAX_LIST = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT_TEXT_RE = /^-?\d{1,20}$/;
const SMALL_INT_RE = /^-?\d{1,15}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function intText(value: unknown): string | null {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null;
  if (typeof value === 'string' && INT_TEXT_RE.test(value)) return value;
  return null;
}

function scalar(kind: ScalarKind, value: unknown): ElsValue {
  switch (kind) {
    case 'id':
    case 'text':
      return typeof value === 'string' && value.length <= MAX_TEXT ? value : null;
    case 'santim':
    case 'intText':
      return intText(value);
    case 'int':
      if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
      if (typeof value === 'string' && SMALL_INT_RE.test(value)) return Number(value);
      return null;
    case 'bool':
      return typeof value === 'boolean' ? value : null;
    case 'datetime': {
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
      if (typeof value !== 'string' || value.length > 40) return null;
      const ms = Date.parse(value);
      return Number.isNaN(ms) ? null : new Date(ms).toISOString();
    }
    case 'date':
      return isBusinessDate(value) ? value : null;
  }
}

function pick(fields: readonly FieldSpec[], source: unknown): { [key: string]: ElsValue } {
  const object = isPlainObject(source) ? source : {};
  const out: { [key: string]: ElsValue } = {};
  for (const spec of fields) {
    const [name, kind] = spec;
    const value = Object.hasOwn(object, name) ? object[name] : undefined;
    if (kind === 'list') {
      out[name] = Array.isArray(value)
        ? value.slice(0, MAX_LIST).map((item: unknown) => pick(spec[2] ?? [], item))
        : null;
    } else if (kind === 'object') {
      out[name] = isPlainObject(value) ? pick(spec[2] ?? [], value) : null;
    } else {
      out[name] = scalar(kind, value);
    }
  }
  return out;
}

/**
 * The ELS record of an outbox event, or null when the type is not reported.
 * Never throws on a malformed payload: a field that is missing or of the
 * wrong shape is reported as null, so every reportable event yields a record.
 */
export function buildElsRecord(input: {
  outboxId: bigint | string;
  type: string;
  occurredAt: Date;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
}): ElsRecord | null {
  const fields = Object.hasOwn(ELS_EVENT_FIELDS, input.type)
    ? ELS_EVENT_FIELDS[input.type]
    : undefined;
  if (fields === undefined) return null;
  const outboxId = String(input.outboxId);
  if (!/^\d+$/.test(outboxId)) throw new RangeError(`invalid outbox id: ${outboxId}`);
  const payload = isPlainObject(input.payload) ? input.payload : {};
  const userId = payload.userId;
  return {
    schema: ELS_RECORD_SCHEMA,
    outboxId,
    type: input.type,
    occurredAt: input.occurredAt.toISOString(),
    businessDate: businessDateOf(input.occurredAt),
    playerRef: typeof userId === 'string' && UUID_RE.test(userId) ? userId.toLowerCase() : null,
    refType: input.aggregateType,
    refId: input.aggregateId,
    data: pick(fields, payload),
  };
}

/**
 * Canonical JSON: object keys sorted (by UTF-16 code unit), no whitespace,
 * so equal records always give the same bytes (and the same hash).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
  }
}

/** The stream line of a record (canonical JSON, without the trailing newline). */
export function elsRecordLine(record: ElsRecord): string {
  return canonicalJson(record);
}
