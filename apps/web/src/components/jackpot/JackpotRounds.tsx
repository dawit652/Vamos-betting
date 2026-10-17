import type {
  JackpotGameView,
  JackpotPrizeTierView,
  JackpotRoundView,
  MultiBonusView,
} from '@vamos/contracts';
import type { Locale } from '@vamos/i18n/locales';
import type { Translator } from '@vamos/i18n/translate';
import { getLocale, getT } from '@/i18n/server';
import { formatDateTime } from '../account/dates';
import { bonusPercent } from '../account/bets';
import { Chip } from '../account/ui';
import { formatMoney, formatOddsMilli, formatTime, formatDayMonth } from '@/lib/format';
import { localName } from '@/lib/localized';
import { EntryForm, type FormGame } from './EntryForm';
import { ROUND_STATUS_LABEL, roundStatusTone } from './jackpot';

/**
 * Server-rendered parts of the jackpot page: the open rounds (prize tiers and
 * the interactive entry form), the recent rounds with results, and the
 * multi-bonus ladder. Only <EntryForm> is a client island.
 */

function teams(game: JackpotGameView, locale: Locale, t: Translator): string {
  return t('sportsbook.match.versus', {
    home: localName(game.homeTeam, locale),
    away: localName(game.awayTeam, locale),
  });
}

function PrizeTiers({ tiers, t }: { tiers: readonly JackpotPrizeTierView[]; t: Translator }) {
  return (
    <section className="space-y-1">
      <h3 className="text-xs font-bold uppercase text-muted">
        {t('account.jackpot.prizes.title')}
      </h3>
      <ul className="divide-y divide-line rounded border border-line text-xs">
        {tiers.map((tier) => (
          <li key={tier.correct} className="flex items-baseline justify-between gap-2 px-2 py-1">
            <span>
              {t('account.jackpot.prizes.correct', { count: tier.correct })}{' '}
              <span className="text-muted">({t(`account.jackpot.prizes.${tier.kind}`)})</span>
            </span>
            <span className="font-bold tabular-nums">{formatMoney(tier.amount)}</span>
          </li>
        ))}
      </ul>
      {tiers.some((tier) => tier.kind === 'shared') ? (
        <p className="text-xxs text-muted">{t('account.jackpot.prizes.sharedNote')}</p>
      ) : null}
    </section>
  );
}

function RoundHeader({
  round,
  t,
  locale,
}: {
  round: JackpotRoundView;
  t: Translator;
  locale: Locale;
}) {
  return (
    <header className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <h2 className="text-base font-bold">
          {t(`account.jackpot.templateName.${round.templateCode}`)}
        </h2>
        <p className="text-xs text-muted">
          {t('account.jackpot.gameCount', { count: round.gameCount })} ·{' '}
          {t('account.jackpot.closesAt', { time: formatDateTime(round.closesAt, locale) })}
        </p>
      </div>
      <div className="flex flex-none flex-col items-end gap-1">
        <Chip tone={roundStatusTone(round.status)}>{t(ROUND_STATUS_LABEL[round.status])}</Chip>
        <p className="text-xxs text-muted">{t('account.jackpot.pool')}</p>
        <p className="text-lg leading-none font-extrabold text-brand tabular-nums">
          {formatMoney(round.pool)}
        </p>
      </div>
    </header>
  );
}

/** An open round: summary, prizes and the entry form. */
export async function OpenRound({ round }: { round: JackpotRoundView }) {
  const [t, locale] = await Promise.all([getT(), getLocale()]);
  const games: FormGame[] = round.games.map((game) => ({
    position: game.position,
    teams: teams(game, locale, t),
    gameId: game.gameId,
    kickoff: `${formatDayMonth(game.startTime)} ${formatTime(game.startTime, locale)}`,
    odds: game.odds
      ? {
          '1': formatOddsMilli(game.odds['1']),
          X: formatOddsMilli(game.odds.X),
          '2': formatOddsMilli(game.odds['2']),
        }
      : null,
  }));
  return (
    <article className="card space-y-3">
      <RoundHeader round={round} t={t} locale={locale} />
      <p className="text-xs text-muted">
        {t('account.jackpot.costPerCombination', { amount: formatMoney(round.costPerCombination) })}{' '}
        · {t('account.jackpot.maxCombinations', { count: round.maxCombinations })}
      </p>
      <PrizeTiers tiers={round.prizeTiers} t={t} />
      <EntryForm
        roundId={round.id}
        costPerCombination={round.costPerCombination}
        maxCombinations={round.maxCombinations}
        games={games}
      />
    </article>
  );
}

/** A past round: its results and what each prize tier paid. */
export async function RecentRound({ round }: { round: JackpotRoundView }) {
  const [t, locale] = await Promise.all([getT(), getLocale()]);
  const { settlement } = round;
  return (
    <article className="card space-y-2">
      <RoundHeader round={round} t={t} locale={locale} />
      {settlement?.void ? (
        <p className="text-xs font-semibold text-muted">{t('account.jackpot.recent.void')}</p>
      ) : null}
      <ul className="divide-y divide-line border-y border-line text-xs">
        {round.games.map((game) => (
          <li key={game.eventId} className="flex items-center justify-between gap-2 py-1">
            <span className="min-w-0 truncate">{teams(game, locale, t)}</span>
            <span className="flex flex-none items-center gap-1.5 font-bold tabular-nums">
              {game.score ? (
                <span className="font-normal text-muted">
                  {game.score.home}-{game.score.away}
                </span>
              ) : null}
              {game.result === null ? (
                '–'
              ) : game.result === 'cancelled' ? (
                <span className="font-normal text-muted">
                  {t('account.jackpot.recent.cancelledGame')}
                </span>
              ) : (
                <span className="rounded bg-brand px-1.5 py-0.5 text-brand-ink">{game.result}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {settlement && !settlement.void ? (
        <>
          <p className="text-xs text-muted">
            {settlement.winners > 0
              ? t('account.jackpot.recent.winners', { count: settlement.winners })
              : t('account.jackpot.recent.noWinners')}
            {settlement.cancelledGames > 0
              ? ` ${t('account.jackpot.recent.cancelledGames', { count: settlement.cancelledGames })}`
              : ''}
          </p>
          <ul className="divide-y divide-line rounded border border-line text-xs">
            {settlement.payouts.map((tier) => (
              <li
                key={tier.correct}
                className="flex items-baseline justify-between gap-2 px-2 py-1"
              >
                <span>{t('account.jackpot.prizes.correct', { count: tier.correct })}</span>
                <span className="text-right tabular-nums">
                  {tier.winningCombinations === '0' ? (
                    <span className="text-muted">{t('account.jackpot.recent.noWinner')}</span>
                  ) : (
                    <>
                      <span className="font-bold">
                        {t('account.jackpot.recent.perCombination', {
                          amount: formatMoney(tier.prizePerCombination),
                        })}
                      </span>
                      <span className="block text-xxs text-muted">
                        {t('account.jackpot.recent.combinations', {
                          count: tier.winningCombinations,
                        })}
                      </span>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {!settlement && round.status === 'closed' ? (
        <p className="text-xs text-muted">{t('account.jackpot.recent.waiting')}</p>
      ) : null}
    </article>
  );
}

/** The accumulator bonus ladder. */
export async function MultiBonusLadder({ bonus }: { bonus: MultiBonusView }) {
  if (!bonus.enabled || bonus.tiers.length === 0) return null;
  const t = await getT();
  return (
    <section className="card space-y-2">
      <h2 className="text-base font-bold">{t('account.jackpot.promo.title')}</h2>
      <p className="text-xs text-muted">{t('account.jackpot.promo.text')}</p>
      <ul className="divide-y divide-line rounded border border-line text-xs">
        {bonus.tiers.map((tier) => (
          <li key={tier.minLegs} className="flex justify-between gap-2 px-2 py-1">
            <span>{t('account.jackpot.promo.legs', { count: tier.minLegs })}</span>
            <span className="font-bold text-up tabular-nums">
              {t('account.jackpot.promo.bonus', { percent: bonusPercent(tier.percentBps) })}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xxs text-muted">
        {t('account.jackpot.promo.minOdds', { odds: formatOddsMilli(bonus.minLegOddsMilli) })}{' '}
        {t('account.jackpot.promo.maxBonus', { amount: formatMoney(bonus.maxBonus) })}
      </p>
    </section>
  );
}
