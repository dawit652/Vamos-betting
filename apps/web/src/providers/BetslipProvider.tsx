'use client';

import type { OddsChangePolicy } from '@vamos/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  EMPTY_SLIP,
  hasOddsChanges,
  parseStoredSlip,
  serializeSlip,
  SLIP_STORAGE_KEY,
  slipReducer,
  toggleLeg,
  type NewSlipLeg,
  type SlipLeg,
  type SlipState,
  type ToggleOutcome,
} from '@/lib/betslip/state';

/**
 * The betslip store: React context + localStorage (survives reloads, synced
 * across tabs). Pure rules live in src/lib/betslip/state.ts.
 *
 * Odds buttons: `const slip = useBetslip(); slip.toggle(leg)` and
 * `aria-pressed={slip.has(selection.id)}`. The drawer (built by the sportsbook
 * pages) reads `isOpen` / `close()` and the slip fields.
 */
export interface BetslipValue {
  legs: readonly SlipLeg[];
  count: number;
  /** Santim wire string. */
  stake: string;
  oddsChangePolicy: OddsChangePolicy;
  /** A live update moved a price since the player added or accepted it. */
  oddsChanged: boolean;
  /** False until the saved slip has been read from localStorage. */
  hydrated: boolean;
  has: (selectionId: string) => boolean;
  /** Odds-button tap: add, replace the same event's pick, remove, or refuse at 40 legs. */
  toggle: (leg: NewSlipLeg) => ToggleOutcome;
  remove: (selectionId: string) => void;
  clear: () => void;
  setStake: (santim: string) => void;
  setOddsChangePolicy: (policy: OddsChangePolicy) => void;
  /** Apply live price changes (from the SSE stream or a quote). */
  updateOdds: (changes: readonly { selectionId: string; oddsMilli: number }[]) => void;
  acceptOddsChanges: () => void;
  /** Replace the slip, e.g. after loading a booking code. */
  replaceLegs: (legs: readonly NewSlipLeg[]) => void;
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

const BetslipContext = createContext<BetslipValue | null>(null);

function readStorage(): SlipState | null {
  try {
    return parseStoredSlip(window.localStorage.getItem(SLIP_STORAGE_KEY));
  } catch {
    return null; // storage disabled (private mode, quota)
  }
}

export function BetslipProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(slipReducer, EMPTY_SLIP);
  const [hydrated, setHydrated] = useState(false);
  const [isOpen, setOpen] = useState(false);
  const stateRef = useRef(state);
  const lastWritten = useRef<string | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Load after mount, so the server HTML and the first client render match.
  useEffect(() => {
    const saved = readStorage();
    if (saved !== null) dispatch({ type: 'hydrate', state: saved });
    setHydrated(true);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== SLIP_STORAGE_KEY) return;
      const next = parseStoredSlip(event.newValue);
      lastWritten.current = event.newValue;
      dispatch({ type: 'hydrate', state: next ?? EMPTY_SLIP });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const json = serializeSlip(state);
    if (json === lastWritten.current) return;
    lastWritten.current = json;
    try {
      window.localStorage.setItem(SLIP_STORAGE_KEY, json);
    } catch {
      // storage full or disabled: the slip still works for this page view
    }
  }, [state, hydrated]);

  const toggle = useCallback((leg: NewSlipLeg): ToggleOutcome => {
    const { state: next, outcome } = toggleLeg(stateRef.current, leg);
    stateRef.current = next; // a second tap before re-render sees this tap's result
    dispatch({ type: 'toggle', leg });
    return outcome;
  }, []);

  const actions = useMemo(
    () => ({
      remove: (selectionId: string) => dispatch({ type: 'remove', selectionId }),
      clear: () => dispatch({ type: 'clear' }),
      setStake: (stake: string) => dispatch({ type: 'setStake', stake }),
      setOddsChangePolicy: (policy: OddsChangePolicy) => dispatch({ type: 'setPolicy', policy }),
      updateOdds: (changes: readonly { selectionId: string; oddsMilli: number }[]) =>
        dispatch({ type: 'updateOdds', changes }),
      acceptOddsChanges: () => dispatch({ type: 'acceptOdds' }),
      replaceLegs: (legs: readonly NewSlipLeg[]) => dispatch({ type: 'replaceLegs', legs }),
      open: () => setOpen(true),
      close: () => setOpen(false),
    }),
    [],
  );

  const value = useMemo<BetslipValue>(() => {
    const ids = new Set(state.legs.map((l) => l.selectionId));
    return {
      legs: state.legs,
      count: state.legs.length,
      stake: state.stake,
      oddsChangePolicy: state.oddsChangePolicy,
      oddsChanged: hasOddsChanges(state),
      hydrated,
      has: (selectionId: string) => ids.has(selectionId),
      toggle,
      isOpen,
      ...actions,
    };
  }, [state, hydrated, isOpen, toggle, actions]);

  return <BetslipContext value={value}>{children}</BetslipContext>;
}

export function useBetslip(): BetslipValue {
  const value = useContext(BetslipContext);
  if (value === null) throw new Error('useBetslip must be used inside <BetslipProvider>');
  return value;
}
