import type { AgentStatementView, RetailAlertKind } from '@vamos/contracts';
import { formatSantim } from './format';

/** "123456" → "1234.56": birr with two decimals, no thousands separators (spreadsheet-safe). */
export function santimToBirr(value: string): string {
  return formatSantim(value).replace(/,/g, '');
}

/** One CSV field: quoted when it holds a comma, a quote or a line break. */
function csvField(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const STATEMENT_CSV_HEADER = [
  'Agent number',
  'Agent name',
  'Week start',
  'Tickets sold',
  'Sold stakes (ETB)',
  'Tickets cancelled',
  'Cancelled stakes (ETB)',
  'Settled stakes (ETB)',
  'Settled payouts (ETB)',
  'GGR (ETB)',
  'Tickets paid',
  'Paid out (ETB)',
  'Expired winners (ETB)',
  'Player cash in (ETB)',
  'Player cash out (ETB)',
  'Balance start (ETB)',
  'Balance end (ETB)',
  'Commission kind',
  'Commission percent',
  'Commission (ETB)',
  'Paid at',
  'Payment reference',
] as const;

/** Basis points as a percent without float math: 1050 → "10.5", 1000 → "10". */
export function bpsToPercentText(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const rest = String(bps % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return rest === '' ? String(whole) : `${whole}.${rest}`;
}

/** The statements as CSV text (CRLF lines): a header, then one line per agent. */
export function statementsCsv(rows: readonly AgentStatementView[]): string {
  const lines = rows.map((r) =>
    [
      r.agentNumber,
      r.agentName,
      r.weekStart,
      r.ticketsSold,
      santimToBirr(r.soldStakes),
      r.ticketsCancelled,
      santimToBirr(r.cancelledStakes),
      santimToBirr(r.settledStakes),
      santimToBirr(r.settledPayouts),
      santimToBirr(r.ggr),
      r.ticketsPaid,
      santimToBirr(r.paidAmount),
      santimToBirr(r.expiredAmount),
      santimToBirr(r.playerCashIn),
      santimToBirr(r.playerCashOut),
      santimToBirr(r.balanceStart),
      santimToBirr(r.balanceEnd),
      r.commissionKind,
      bpsToPercentText(r.commissionBps),
      santimToBirr(r.commission),
      r.paidAt ?? '',
      r.paidReference ?? '',
    ]
      .map(csvField)
      .join(','),
  );
  return [STATEMENT_CSV_HEADER.map(csvField).join(','), ...lines].join('\r\n') + '\r\n';
}

/**
 * `count` Mondays, newest first, starting at `latest` (a Monday "YYYY-MM-DD"); UTC date math,
 * so a time zone cannot shift a calendar date.
 */
export function weekOptions(latest: string, count = 12): string[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(latest);
  if (match === null) return [];
  const start = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Array.from({ length: count }, (_, i) =>
    new Date(start - i * 7 * 86_400_000).toISOString().slice(0, 10),
  );
}

export const ALERT_KIND_LABELS: Record<RetailAlertKind, string> = {
  big_win: 'Big win',
  repeated_picks: 'Same picks sold across shops',
  many_cancels: 'Many cancels',
  late_ticket: 'Ticket sold just before kick-off',
  low_balance: 'Low agent balance',
  payout_waiting: 'Payout waiting for HQ',
  device_waiting: 'Device waiting for approval',
};

/** The readable name of an alert kind; an unknown kind is humanized rather than hidden. */
export function alertKindLabel(kind: string): string {
  return (ALERT_KIND_LABELS as Record<string, string | undefined>)[kind] ?? kind.replace(/_/g, ' ');
}

const MONEY_KEY = /(amount|stake|win|payout|balance|threshold|total)/i;

/** An alert's details as "key: value" parts; amounts that are santim strings show as birr. */
export function alertDetailLines(details: Record<string, unknown>): string[] {
  return Object.entries(details).map(([key, value]) => {
    const label = key
      .replace(/([A-Z])/g, ' $1')
      .replace(/_/g, ' ')
      .toLowerCase();
    let text: string;
    if (value === null || value === undefined) text = '–';
    else if (typeof value === 'string' && MONEY_KEY.test(key) && /^-?\d+$/.test(value))
      text = `ETB ${formatSantim(value)}`;
    else if (typeof value === 'object') text = JSON.stringify(value);
    else text = typeof value === 'string' ? value : `${value as number | boolean}`;
    return `${label}: ${text}`;
  });
}
