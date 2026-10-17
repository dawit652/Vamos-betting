import type { UserMessage } from '@vamos/contracts';
import type { MessageKey } from '@vamos/i18n/translate';
import { formatMoney } from '@/lib/format';

/**
 * The per-player push stream (GET /me/stream), client side and pure: frame
 * parsing (no zod in the browser) and what each message means for the UI.
 * Messages are hints, not state: a bet message tells the page which bet to
 * re-fetch; delivery is best effort, so pages also re-fetch on reconnect.
 */

export const USER_MESSAGE_TYPES = [
  'bet.accepted',
  'bet.rejected',
  'bet.settled',
  'bet.cashed_out',
  'bet.reopened',
  'jackpot.settled',
  'wallet.changed',
] as const;

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;
const isAmount = (v: unknown): v is string => typeof v === 'string' && /^\d{1,19}$/.test(v);

/** Parses one SSE frame (`event` name and `data` text); null when it is not a valid message. */
export function parseUserFrame(type: string, data: string): UserMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  // The published envelope is { type, data }; the SSE body may carry either that or just `data`.
  const envelope = raw as Record<string, unknown>;
  const body = (
    typeof envelope.type === 'string' && envelope.data !== null && typeof envelope.data === 'object'
      ? envelope.data
      : raw
  ) as Record<string, unknown>;
  if (typeof envelope.type === 'string' && envelope.type !== type) return null;

  if (type === 'wallet.changed') {
    if (!isAmount(body.cash) || !isAmount(body.bonus)) return null;
    return { type, data: { cash: body.cash, bonus: body.bonus } };
  }
  if (type === 'jackpot.settled') {
    const status = body.status;
    if (status !== 'won' && status !== 'lost' && status !== 'void') return null;
    const code = body.templateCode;
    if (code !== 'daily9' && code !== 'weekly13') return null;
    if (!isStr(body.entryId) || !isStr(body.roundId)) return null;
    if (!isAmount(body.gross) || !isAmount(body.tax) || !isAmount(body.net)) return null;
    if (!isAmount(body.refund)) return null;
    const best = body.bestCorrect;
    if (best !== null && !(typeof best === 'number' && Number.isInteger(best) && best >= 0)) {
      return null;
    }
    return {
      type,
      data: {
        entryId: body.entryId,
        roundId: body.roundId,
        templateCode: code,
        status,
        gross: body.gross,
        tax: body.tax,
        net: body.net,
        refund: body.refund,
        bestCorrect: best,
      },
    };
  }
  if (!isStr(body.betId) || !isStr(body.shortId)) return null;
  const ref = { betId: body.betId, shortId: body.shortId };
  switch (type) {
    case 'bet.accepted':
      if (typeof body.oddsChanged !== 'boolean') return null;
      return { type, data: { ...ref, oddsChanged: body.oddsChanged } };
    case 'bet.rejected':
      if (typeof body.reason !== 'string' || !isAmount(body.refund)) return null;
      return { type, data: { ...ref, reason: body.reason, refund: body.refund } };
    case 'bet.settled': {
      const status = body.status;
      if (status !== 'won' && status !== 'lost' && status !== 'void') return null;
      if (!isAmount(body.gross) || !isAmount(body.tax) || !isAmount(body.net)) return null;
      if (typeof body.corrected !== 'boolean') return null;
      return {
        type,
        data: {
          ...ref,
          status,
          gross: body.gross,
          tax: body.tax,
          net: body.net,
          corrected: body.corrected,
        },
      };
    }
    case 'bet.cashed_out':
      if (!isAmount(body.gross) || !isAmount(body.tax) || !isAmount(body.net)) return null;
      return { type, data: { ...ref, gross: body.gross, tax: body.tax, net: body.net } };
    case 'bet.reopened':
      return { type, data: ref };
    default:
      return null;
  }
}

export interface UserToast {
  key: MessageKey;
  params: Record<string, string>;
  tone: 'success' | 'info' | 'error';
}

export interface UserEffect {
  /** The bet to re-fetch (null for wallet messages). */
  betId: string | null;
  /** The balance moved: refresh the balance chip. */
  refreshWallet: boolean;
  toast: UserToast | null;
}

const SETTLED_KEY = {
  won: 'account.notify.won',
  lost: 'account.notify.lost',
  void: 'account.notify.void',
} as const satisfies Record<'won' | 'lost' | 'void', MessageKey>;

const CORRECTED_KEY = {
  won: 'account.notify.correctedWon',
  lost: 'account.notify.correctedLost',
  void: 'account.notify.correctedVoid',
} as const satisfies Record<'won' | 'lost' | 'void', MessageKey>;

const JACKPOT_KEY = {
  won: 'account.notify.jackpotWon',
  lost: 'account.notify.jackpotLost',
  void: 'account.notify.jackpotVoid',
} as const satisfies Record<'won' | 'lost' | 'void', MessageKey>;

/** What a message does to the screen: which bet to re-fetch, a toast, a balance refresh. */
export function describeUserMessage(message: UserMessage): UserEffect {
  switch (message.type) {
    case 'wallet.changed':
      return { betId: null, refreshWallet: true, toast: null };
    case 'bet.accepted':
      return {
        betId: message.data.betId,
        refreshWallet: false,
        toast: {
          key: message.data.oddsChanged
            ? 'account.notify.acceptedOddsChanged'
            : 'account.notify.accepted',
          params: { id: message.data.shortId },
          tone: 'success',
        },
      };
    case 'bet.rejected':
      return {
        betId: message.data.betId,
        refreshWallet: true,
        toast: {
          key: 'account.notify.rejected',
          params: { id: message.data.shortId, refund: formatMoney(message.data.refund) },
          tone: 'error',
        },
      };
    case 'bet.settled':
      return {
        betId: message.data.betId,
        refreshWallet: true,
        toast: {
          key: (message.data.corrected ? CORRECTED_KEY : SETTLED_KEY)[message.data.status],
          params: { id: message.data.shortId, net: formatMoney(message.data.net) },
          tone: message.data.status === 'won' ? 'success' : 'info',
        },
      };
    case 'bet.cashed_out':
      return {
        betId: message.data.betId,
        refreshWallet: true,
        toast: {
          key: 'account.notify.cashedOut',
          params: { id: message.data.shortId, net: formatMoney(message.data.net) },
          tone: 'success',
        },
      };
    case 'bet.reopened':
      return {
        betId: message.data.betId,
        refreshWallet: true,
        toast: {
          key: 'account.notify.reopened',
          params: { id: message.data.shortId },
          tone: 'info',
        },
      };
    case 'jackpot.settled':
      return {
        betId: null,
        refreshWallet: true,
        toast: {
          key: JACKPOT_KEY[message.data.status],
          params: { net: formatMoney(message.data.net), refund: formatMoney(message.data.refund) },
          tone: message.data.status === 'won' ? 'success' : 'info',
        },
      };
  }
}
