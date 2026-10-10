import type { LocalizedNameValue, OddsChangePolicy } from '@vamos/contracts';

/**
 * Betslip state, pure (no React, no storage) so it is unit tested.
 * Rules: at most 40 legs, one selection per event (picking another selection of
 * the same event replaces the old one), picking the same selection again removes it.
 * The stake is a santim wire string ("1000" = 10 ETB).
 */

/** DEFAULT_BET_RULES.maxLegs in @vamos/core (copied to keep the rules module out of the bundle; a test keeps them equal). */
export const MAX_SLIP_LEGS = 40;
export const DEFAULT_STAKE = '1000';
export const DEFAULT_ODDS_CHANGE_POLICY: OddsChangePolicy = 'higher';
const ODDS_CHANGE_POLICIES: readonly OddsChangePolicy[] = ['none', 'higher', 'any'];

export interface SlipLeg {
  selectionId: string;
  eventId: string;
  /** Odds (milli) the player accepted; sent as `oddsMilli` when placing. */
  oddsMilli: number;
  /** Set when a live update moved the price; cleared by `acceptOdds`. */
  previousOddsMilli: number | null;
  gameId: string;
  sport: string;
  home: LocalizedNameValue;
  away: LocalizedNameValue;
  marketName: LocalizedNameValue;
  selectionName: LocalizedNameValue;
  startTime: string;
  live: boolean;
}

/** What the sportsbook pages pass when a player taps an odds button. */
export type NewSlipLeg = Omit<SlipLeg, 'previousOddsMilli'>;

export interface SlipState {
  legs: SlipLeg[];
  stake: string;
  oddsChangePolicy: OddsChangePolicy;
}

export const EMPTY_SLIP: SlipState = {
  legs: [],
  stake: DEFAULT_STAKE,
  oddsChangePolicy: DEFAULT_ODDS_CHANGE_POLICY,
};

export type ToggleOutcome = 'added' | 'replaced' | 'removed' | 'limit';

export type SlipAction =
  | { type: 'toggle'; leg: NewSlipLeg }
  | { type: 'add'; leg: NewSlipLeg }
  | { type: 'remove'; selectionId: string }
  | { type: 'clear' }
  | { type: 'setStake'; stake: string }
  | { type: 'setPolicy'; policy: OddsChangePolicy }
  | { type: 'updateOdds'; changes: readonly { selectionId: string; oddsMilli: number }[] }
  | { type: 'acceptOdds' }
  | { type: 'replaceLegs'; legs: readonly NewSlipLeg[] }
  | { type: 'hydrate'; state: SlipState };

function toLeg(leg: NewSlipLeg): SlipLeg {
  return { ...leg, previousOddsMilli: null };
}

/** What tapping this selection would do (and the resulting state). */
export function toggleLeg(
  state: SlipState,
  leg: NewSlipLeg,
): { state: SlipState; outcome: ToggleOutcome } {
  if (state.legs.some((l) => l.selectionId === leg.selectionId)) {
    return {
      state: { ...state, legs: state.legs.filter((l) => l.selectionId !== leg.selectionId) },
      outcome: 'removed',
    };
  }
  return addLeg(state, leg);
}

/** Adds a leg, replacing a pick on the same event; never removes. */
export function addLeg(
  state: SlipState,
  leg: NewSlipLeg,
): { state: SlipState; outcome: Exclude<ToggleOutcome, 'removed'> } {
  const sameEvent = state.legs.findIndex((l) => l.eventId === leg.eventId);
  if (sameEvent !== -1) {
    const legs = state.legs.slice();
    legs[sameEvent] = toLeg(leg);
    return { state: { ...state, legs }, outcome: 'replaced' };
  }
  if (state.legs.length >= MAX_SLIP_LEGS) return { state, outcome: 'limit' };
  return { state: { ...state, legs: [...state.legs, toLeg(leg)] }, outcome: 'added' };
}

export function slipReducer(state: SlipState, action: SlipAction): SlipState {
  switch (action.type) {
    case 'toggle':
      return toggleLeg(state, action.leg).state;
    case 'add':
      return addLeg(state, action.leg).state;
    case 'remove':
      return { ...state, legs: state.legs.filter((l) => l.selectionId !== action.selectionId) };
    case 'clear':
      return { ...state, legs: [] };
    case 'setStake':
      return /^\d+$/.test(action.stake) ? { ...state, stake: action.stake } : state;
    case 'setPolicy':
      return ODDS_CHANGE_POLICIES.includes(action.policy)
        ? { ...state, oddsChangePolicy: action.policy }
        : state;
    case 'updateOdds': {
      const next = new Map(action.changes.map((c) => [c.selectionId, c.oddsMilli]));
      let changed = false;
      const legs = state.legs.map((leg) => {
        const odds = next.get(leg.selectionId);
        if (odds === undefined || odds === leg.oddsMilli || !isOdds(odds)) return leg;
        changed = true;
        return {
          ...leg,
          oddsMilli: odds,
          previousOddsMilli: leg.previousOddsMilli ?? leg.oddsMilli,
        };
      });
      return changed ? { ...state, legs } : state;
    }
    case 'acceptOdds':
      return state.legs.some((l) => l.previousOddsMilli !== null)
        ? { ...state, legs: state.legs.map((l) => ({ ...l, previousOddsMilli: null })) }
        : state;
    case 'replaceLegs': {
      let next: SlipState = { ...state, legs: [] };
      for (const leg of action.legs) next = addLeg(next, leg).state;
      return next;
    }
    case 'hydrate':
      return action.state;
  }
}

/** True when any leg's price moved since the player added or accepted it. */
export function hasOddsChanges(state: SlipState): boolean {
  return state.legs.some((l) => l.previousOddsMilli !== null);
}

// ---- persistence (localStorage) -------------------------------------------------------------

export const SLIP_STORAGE_KEY = 'vamos_betslip_v1';

function isOdds(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 1001 && value <= 1_000_000
  );
}

function isName(value: unknown): value is LocalizedNameValue {
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).every(([, v]) => typeof v === 'string') && 'en' in value;
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

function parseLeg(raw: unknown): SlipLeg | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (
    !isString(r.selectionId) ||
    !isString(r.eventId) ||
    !isOdds(r.oddsMilli) ||
    !isString(r.gameId) ||
    !isString(r.sport) ||
    !isName(r.home) ||
    !isName(r.away) ||
    !isName(r.marketName) ||
    !isName(r.selectionName) ||
    !isString(r.startTime) ||
    typeof r.live !== 'boolean'
  ) {
    return null;
  }
  return {
    selectionId: r.selectionId,
    eventId: r.eventId,
    oddsMilli: r.oddsMilli,
    previousOddsMilli: isOdds(r.previousOddsMilli) ? r.previousOddsMilli : null,
    gameId: r.gameId,
    sport: r.sport,
    home: r.home,
    away: r.away,
    marketName: r.marketName,
    selectionName: r.selectionName,
    startTime: r.startTime,
    live: r.live,
  };
}

/** Restores a slip saved by `serializeSlip`; drops invalid legs, returns null for garbage. */
export function parseStoredSlip(json: string | null): SlipState | null {
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const legs = Array.isArray(r.legs) ? r.legs.map(parseLeg) : [];
  let state: SlipState = {
    legs: [],
    stake: typeof r.stake === 'string' && /^\d{1,15}$/.test(r.stake) ? r.stake : DEFAULT_STAKE,
    oddsChangePolicy: ODDS_CHANGE_POLICIES.includes(r.oddsChangePolicy as OddsChangePolicy)
      ? (r.oddsChangePolicy as OddsChangePolicy)
      : DEFAULT_ODDS_CHANGE_POLICY,
  };
  for (const leg of legs) {
    if (leg !== null) state = addLeg(state, leg).state;
  }
  // addLeg resets previousOddsMilli; restore it so a pending odds change survives a reload.
  const previous = new Map(
    legs.filter((l): l is SlipLeg => l !== null).map((l) => [l.selectionId, l.previousOddsMilli]),
  );
  state.legs = state.legs.map((l) => ({
    ...l,
    previousOddsMilli: previous.get(l.selectionId) ?? null,
  }));
  return state;
}

export function serializeSlip(state: SlipState): string {
  return JSON.stringify(state);
}
