import type {
  BetLegView,
  BetView,
  BookingCodeResponse,
  LocalizedNameValue,
  QuoteLeg,
  QuoteResponse,
} from '@vamos/contracts';
import {
  amharicName,
  factoryMarketName,
  factorySelectionLabel,
  formatGameId,
  isFactoryOnlyMarketType,
  MARKET_TYPES,
  selectionLabel,
  toWire,
  type CashOutConfig,
  type MarketTypeCode,
} from '@vamos/core';
import {
  cashedOutView,
  cashOutOfferView,
  priceCashOut,
  type BookingCode,
  type BookingLeg,
  type QuotedLeg,
  type SelectionSnapshot,
  type SlipQuote,
  type UserBet,
  type UserBetLeg,
} from '@vamos/db';
import { isMarketTypeCode, isSportCode } from '../catalog/views';

/**
 * Pure builders of the betting wire views (no I/O). Money goes out as santim
 * strings (toWire), odds as integer milli, times as ISO strings.
 */

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());
const wire = (amount: bigint | null): string | null => (amount === null ? null : toWire(amount));

/** "Home vs Away" in English (the betslip and bet history line). */
export function eventName(selection: Pick<SelectionSnapshot, 'homeTeam' | 'awayTeam'>): string {
  return `${selection.homeTeam.en} vs ${selection.awayTeam.en}`;
}

/** A team's name as a wire LocalizedName, with its Amharic filled when it has none (amharicName). */
function teamName(name: SelectionSnapshot['homeTeam']): LocalizedNameValue {
  const out: LocalizedNameValue = { en: name.en };
  out.am = name.am !== undefined && name.am.trim() !== '' ? name.am : amharicName(name.en);
  if (name.om !== undefined) out.om = name.om;
  if (name.ti !== undefined) out.ti = name.ti;
  return out;
}

/** The market type's display name; an unknown type falls back to its code. */
export function marketName(
  selection: Pick<SelectionSnapshot, 'marketType'> & { marketLine?: string | null },
): LocalizedNameValue {
  const type = selection.marketType;
  if (!isMarketTypeCode(type)) {
    if (isFactoryOnlyMarketType(type)) {
      try {
        const name = factoryMarketName(type, selection.marketLine ?? null);
        return { en: name.en, am: name.am };
      } catch {
        // a malformed stored line: fall through to the raw code
      }
    }
    return { en: type };
  }
  const { name } = MARKET_TYPES[type];
  return { en: name.en, am: name.am };
}

/** The selection label ("Arsenal", "Draw", "Over 2.5"); a malformed row falls back to its code. */
export function selectionName(
  selection: Pick<
    SelectionSnapshot,
    'marketType' | 'marketLine' | 'code' | 'homeTeam' | 'awayTeam'
  >,
): LocalizedNameValue {
  const type = selection.marketType;
  const factoryOnly = !isMarketTypeCode(type) && isFactoryOnlyMarketType(type);
  if (!isMarketTypeCode(type) && !factoryOnly) return { en: selection.code };
  const label = factoryOnly ? factorySelectionLabel : selectionLabel;
  const en = { home: selection.homeTeam.en, away: selection.awayTeam.en };
  const am = {
    home: selection.homeTeam.am ?? en.home,
    away: selection.awayTeam.am ?? en.away,
  };
  try {
    return {
      en: label(type as MarketTypeCode, selection.code, en, selection.marketLine).en,
      am: label(type as MarketTypeCode, selection.code, am, selection.marketLine).am,
    };
  } catch {
    return { en: selection.code };
  }
}

/** A betslip leg (quote or booking code), with the selection as it is now. */
function slipLegView(
  leg: Pick<QuotedLeg, 'selectionId' | 'available' | 'reason' | 'currentOddsMilli' | 'isLive'> & {
    selection: SelectionSnapshot | null;
  },
  requested: { requestedOddsMilli: number | null; oddsChanged: boolean },
): QuoteLeg {
  const { selection } = leg;
  return {
    selectionId: leg.selectionId,
    eventId: selection?.eventId ?? null,
    gameId: selection === null ? null : formatGameId(selection.gameId),
    eventName: selection === null ? null : eventName(selection),
    marketName: selection === null ? null : marketName(selection),
    selectionName: selection === null ? null : selectionName(selection),
    oddsMilli: leg.currentOddsMilli,
    requestedOddsMilli: requested.requestedOddsMilli,
    oddsChanged: requested.oddsChanged,
    available: leg.available,
    reason: leg.reason,
    live: leg.isLive,
    competitionName: selection === null ? null : localized(selection.competitionName),
    startTime: selection === null ? null : selection.startTime.toISOString(),
  };
}

/** A stored LocalizedName on the wire: only the languages it has. */
function localized(name: SelectionSnapshot['competitionName']): LocalizedNameValue {
  const out: LocalizedNameValue = { en: name.en };
  if (name.am !== undefined) out.am = name.am;
  if (name.om !== undefined) out.om = name.om;
  if (name.ti !== undefined) out.ti = name.ti;
  return out;
}

/** POST /betslip/quote. */
export function quoteView(slip: SlipQuote): QuoteResponse {
  const { quote } = slip;
  return {
    betType: quote.betType,
    legs: slip.legs.map((leg) =>
      slipLegView(leg, {
        requestedOddsMilli: leg.requestedOddsMilli,
        oddsChanged: leg.oddsChanged,
      }),
    ),
    stake: toWire(quote.stake),
    totalOddsMilli: quote.totalOddsMilli.toString(),
    grossReturn: toWire(quote.grossReturn),
    bonusPercentBps: quote.bonusPercentBps,
    bonusAmount: toWire(quote.bonusAmount),
    grossPayout: toWire(quote.grossPayout),
    cappedByMaxPayout: quote.cappedByMaxPayout,
    taxAmount: toWire(quote.taxAmount),
    netPayout: toWire(quote.netPayout),
    errors: quote.errors.map((error) => ({
      code: error.code,
      message: error.message,
      ...(error.selectionId === undefined ? {} : { selectionId: error.selectionId }),
      ...(error.eventId === undefined ? {} : { eventId: error.eventId }),
    })),
  };
}

function bookingLegView(leg: BookingLeg): QuoteLeg {
  return slipLegView(leg, { requestedOddsMilli: null, oddsChanged: false });
}

/** POST /booking-codes and GET /booking-codes/:code. */
export function bookingCodeView(booking: BookingCode): BookingCodeResponse {
  return {
    code: booking.code,
    createdAt: booking.createdAt.toISOString(),
    expiresAt: booking.expiresAt.toISOString(),
    legs: booking.legs.map(bookingLegView),
    stake: booking.stake === null ? null : booking.stake.toString(),
  };
}

export function betLegView(leg: UserBetLeg): BetLegView {
  const { selection } = leg;
  if (!isSportCode(selection.sportId)) {
    throw new Error(`bet leg ${leg.id} is on unknown sport ${selection.sportId}`);
  }
  return {
    selectionId: leg.selectionId,
    eventId: leg.eventId,
    gameId: formatGameId(selection.gameId),
    sport: selection.sportId,
    eventName: eventName(selection),
    homeTeam: teamName(selection.homeTeam),
    awayTeam: teamName(selection.awayTeam),
    startTime: selection.startTime.toISOString(),
    marketName: marketName(selection),
    selectionName: selectionName(selection),
    oddsMilli: leg.oddsMilli,
    live: leg.isLive,
    state: leg.state,
  };
}

/** What betView needs to price an open bet's cash-out offer. */
export interface CashOutPricing {
  /** The cash-out settings in force (GameSettings.cashOut). */
  config: CashOutConfig;
  now: Date;
}

/**
 * A bet as its owner sees it (placement, My Bets). An `open` bet carries its
 * cash-out offer as of `pricing.now` (priceCashOut, pure: the legs' selection
 * snapshots are already loaded); a cashed-out bet what the cash-out paid.
 */
export function betView(bet: UserBet, pricing: CashOutPricing): BetView {
  return {
    id: bet.id,
    shortId: bet.shortId,
    betType: bet.betType,
    status: bet.status,
    channel: bet.channel,
    oddsChangePolicy: bet.oddsChangePolicy,
    stake: toWire(bet.stake),
    totalOddsMilli: bet.totalOddsMilli.toString(),
    potentialGross: toWire(bet.potentialGrossPayout),
    bonusPercentBps: bet.bonusPercentBps,
    potentialBonus: toWire(bet.potentialBonus),
    potentialTax: toWire(bet.potentialTax),
    potentialNet: toWire(bet.potentialNetPayout),
    settledGross: wire(bet.settledGrossPayout),
    settledTax: wire(bet.settledTax),
    settledNet: wire(bet.settledNetPayout),
    rejectReason: bet.rejectReason,
    placedAt: bet.placedAt.toISOString(),
    acceptAfter: iso(bet.acceptAfter),
    acceptedAt: iso(bet.acceptedAt),
    settledAt: iso(bet.settledAt),
    cashOutOffer:
      bet.status === 'open'
        ? cashOutOfferView(priceCashOut(bet, pricing.config, pricing.now))
        : null,
    cashedOut: bet.cashedOut === null ? null : cashedOutView(bet.cashedOut),
    legs: bet.legs.map(betLegView),
  };
}
