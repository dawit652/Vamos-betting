'use client';

import type { ReactNode } from 'react';
import { useT } from '@/i18n/client';
import { matchClock } from './events';
import { useLiveMatch } from './LiveProvider';
import type { EventStatus } from './live-store';

interface Initial {
  eventId: string;
  sport: string;
  status: EventStatus;
  minute: number | null;
  period: string | null;
}

/**
 * "53'", "HT", "Q2" or "FT" for a live match, patched by the live stream.
 * `children` (e.g. the kick-off time) is shown while the match has not started;
 * `className` styles the badge around the clock or status.
 */
export function LiveClock({
  className = '',
  children,
  ...initial
}: Initial & { className?: string; children?: ReactNode }) {
  const t = useT();
  const live = useLiveMatch(initial.eventId);
  const status = live?.status ?? initial.status;
  if (status === 'scheduled' && children !== undefined) return <>{children}</>;
  if (status !== 'live') {
    return (
      <span className={className}>
        {status === 'finished'
          ? t('sportsbook.match.fullTime')
          : t(`sportsbook.match.status.${status}`)}
      </span>
    );
  }
  const clock = matchClock({
    sport: initial.sport,
    minute: live === undefined ? initial.minute : live.minute,
    period: live === undefined ? initial.period : live.period,
  });
  return (
    <span className={className}>
      <span className="font-bold text-live">
        {clock.kind === 'minute'
          ? t('sportsbook.match.minute', { minute: clock.minute })
          : clock.kind === 'halfTime'
            ? t('sportsbook.match.halfTime')
            : clock.kind === 'period'
              ? clock.period
              : t('sportsbook.match.live')}
      </span>
    </span>
  );
}

/** One side's score, patched by the live stream. */
export function LiveScore({
  eventId,
  side,
  initial,
  className = '',
}: {
  eventId: string;
  side: 'home' | 'away';
  initial: number | null;
  className?: string;
}) {
  const live = useLiveMatch(eventId);
  const score = live?.score === undefined || live.score === null ? initial : live.score[side];
  if (score === null) return null;
  return <span className={className}>{score}</span>;
}
