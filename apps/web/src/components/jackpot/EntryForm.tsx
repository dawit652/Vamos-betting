'use client';

import type { JackpotEntryView, JackpotOutcome } from '@vamos/contracts';
import Link from 'next/link';
import { useState } from 'react';
import { useT } from '@/i18n/client';
import { errorMessageKey, isApiClientError } from '@/lib/api/errors';
import { newIdempotencyKey } from '@/lib/api/idempotency';
import { jackpotsApi } from '@/lib/api/jackpots';
import { formatMoney } from '@/lib/format';
import { routes } from '@/lib/routes';
import { useSession } from '@/providers/SessionProvider';
import { createIntentKeys, isDefiniteRefusal } from '../payments/payments';
import { loginHref } from '../account/paths';
import { Alert } from '../account/ui';
import {
  closedMessageKey,
  ENTRY_ERROR_KEYS,
  emptyPicks,
  entryFingerprint,
  entryRequest,
  OUTCOMES,
  summarizePicks,
  togglePick,
} from './jackpot';

/** What the form needs of a game, already localized by the server page. */
export interface FormGame {
  position: number;
  teams: string;
  gameId: string;
  kickoff: string;
  odds: Record<JackpotOutcome, string> | null;
}

/** One key per intent (round and picks), kept at module level so it outlives the form. */
const entryKeys = createIntentKeys(newIdempotencyKey, 'jackpot');

/**
 * The interactive part of an open round: 1 / X / 2 toggles per game (several
 * picks allowed), the live combination count and cost, a confirm step and the
 * placement. The server re-checks everything; this only guides the player.
 */
export function EntryForm({
  roundId,
  costPerCombination,
  maxCombinations,
  games,
}: {
  roundId: string;
  costPerCombination: string;
  maxCombinations: number;
  games: readonly FormGame[];
}) {
  const t = useT();
  const session = useSession();
  const [picks, setPicks] = useState(() => emptyPicks(games.length));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [placed, setPlaced] = useState<JackpotEntryView | null>(null);

  const summary = summarizePicks(picks, { costPerCombination, maxCombinations });
  const cost = formatMoney(summary.cost);

  const toggle = (game: number, outcome: JackpotOutcome) => {
    setPicks((current) => togglePick(current, game, outcome));
    setConfirming(false);
    setError(null);
    setPlaced(null);
  };

  const submit = async () => {
    if (busy || !summary.valid) return;
    setBusy(true);
    setError(null);
    const key = entryKeys.get(entryFingerprint(roundId, picks));
    try {
      const entry = await jackpotsApi.place(roundId, entryRequest(picks), key);
      entryKeys.clear();
      setPlaced(entry);
      setPicks(emptyPicks(games.length));
      void session.refreshWallet();
    } catch (err) {
      if (isDefiniteRefusal(err)) entryKeys.clear();
      setError(err);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const errorKey =
    error === null
      ? null
      : isApiClientError(error) && error.code === 'jackpot_closed'
        ? closedMessageKey(error.details)
        : errorMessageKey(error, ENTRY_ERROR_KEYS);

  return (
    <section className="space-y-2" aria-label={t('account.jackpot.pickHint')}>
      <p className="text-xs text-muted">{t('account.jackpot.pickHint')}</p>
      <ul className="divide-y divide-line border-y border-line">
        {games.map((game) => (
          <li key={game.position} className="space-y-1 py-2">
            <p className="text-xxs text-muted tabular-nums">
              {game.kickoff} · {t('account.jackpot.gameId', { id: game.gameId })}
            </p>
            <p className="truncate text-sm font-semibold">{game.teams}</p>
            <div className="grid grid-cols-3 gap-1">
              {OUTCOMES.map((outcome) => (
                <button
                  key={outcome}
                  type="button"
                  className="odds-btn"
                  aria-pressed={picks[game.position]?.includes(outcome) ?? false}
                  aria-label={`${game.teams}: ${t(`account.jackpot.outcome.${outcome}`)}`}
                  onClick={() => toggle(game.position, outcome)}
                >
                  <span>{outcome}</span>
                  {game.odds ? <span className="odds-label">{game.odds[outcome]}</span> : null}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>

      <dl className="grid grid-cols-3 gap-2 text-xs" aria-live="polite">
        <div>
          <dt className="text-muted">
            {t('account.jackpot.summary.picked', {
              picked: summary.picked,
              total: summary.total,
            })}
          </dt>
        </div>
        <div className="text-center">
          <dt className="text-muted">{t('account.jackpot.summary.combinations')}</dt>
          <dd className="font-bold tabular-nums" data-testid="jackpot-combinations">
            {summary.complete ? summary.combinations : 0}
          </dd>
        </div>
        <div className="text-right">
          <dt className="text-muted">{t('account.jackpot.summary.cost')}</dt>
          <dd className="font-bold tabular-nums" data-testid="jackpot-cost">
            {summary.complete ? cost : formatMoney('0')}
          </dd>
        </div>
      </dl>

      {summary.overMax ? (
        <Alert>{t('account.jackpot.tooMany', { max: maxCombinations })}</Alert>
      ) : null}
      {errorKey ? <Alert>{t(errorKey)}</Alert> : null}
      {placed ? (
        <Alert tone="success">
          {t('account.jackpot.placed', { cost: formatMoney(placed.cost) })}{' '}
          <Link href={`${routes.myBets}?tab=jackpot`} className="underline" prefetch={false}>
            {t('account.jackpot.viewEntries')}
          </Link>
        </Alert>
      ) : null}

      {session.status === 'anonymous' ? (
        <Link href={loginHref(routes.jackpot)} className="btn btn-primary w-full">
          {t('account.jackpot.loginToPlay')}
        </Link>
      ) : confirming ? (
        <div className="space-y-2 rounded border border-line p-2">
          <p className="text-sm font-bold">{t('account.jackpot.confirm.title')}</p>
          <p className="text-xs">
            {t('account.jackpot.confirm.text', { cost, count: summary.combinations })}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-outline flex-1"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              {t('account.jackpot.confirm.back')}
            </button>
            <button
              type="button"
              className="btn btn-accent flex-[2]"
              disabled={busy || !summary.valid}
              onClick={() => void submit()}
            >
              {busy ? t('account.jackpot.placing') : t('account.jackpot.confirm.confirm', { cost })}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-outline"
            disabled={summary.picked === 0}
            onClick={() => {
              setPicks(emptyPicks(games.length));
              setError(null);
            }}
          >
            {t('account.jackpot.clear')}
          </button>
          <button
            type="button"
            className="btn btn-accent flex-1"
            disabled={!summary.valid || session.status === 'loading'}
            onClick={() => setConfirming(true)}
          >
            {t('account.jackpot.place')}
          </button>
        </div>
      )}
      {!summary.complete && summary.picked > 0 ? (
        <p className="text-xxs text-muted">{t('account.jackpot.incomplete')}</p>
      ) : null}
    </section>
  );
}
