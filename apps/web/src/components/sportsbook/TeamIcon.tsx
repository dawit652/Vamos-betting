import type { EventSummary } from '@vamos/contracts';
import { flagEmoji } from '@/lib/flag';
import { monogram } from './events';

const BOX = {
  row: 'h-6 w-6 text-[0.5rem]',
  card: 'h-7 w-7 text-[0.625rem]',
  header: 'h-14 w-14 text-base',
} as const;
const FLAG = { row: 'text-xl', card: 'text-lg', header: 'text-3xl' } as const;

/**
 * A team's mark next to its name (owner, 17 Nov 2026: a flag or a logo for every team): the
 * country flag of a national team (`code`, from teamFlagCodes), else the club's logo when one is
 * stored (`team.logo`, served by /team-logo/<id>), else a crest with its initials. Decorative: the
 * name is beside it.
 */
export function TeamIcon({
  team,
  code,
  size,
}: {
  team: Pick<EventSummary['home'], 'id' | 'shortName' | 'logo'>;
  code: string | null;
  size: keyof typeof BOX;
}) {
  if (code !== null) {
    return size === 'row' ? (
      <span aria-hidden="true" className="flex-none text-xl leading-none">
        {flagEmoji(code)}
      </span>
    ) : (
      <span aria-hidden="true" className={`crest ${BOX[size]}`}>
        <span className={FLAG[size]}>{flagEmoji(code)}</span>
      </span>
    );
  }
  if (team.logo !== undefined) {
    return (
      <span
        aria-hidden="true"
        className={`inline-flex flex-none items-center justify-center rounded-full bg-white p-[2px] ${BOX[size]}`}
      >
        {/* A 64 px PNG of our own: next/image would add nothing at this size. */}
        <img
          src={`/team-logo/${team.id}?v=${team.logo}`}
          alt=""
          width={64}
          height={64}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-contain"
        />
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={`crest ${BOX[size]}`}>
      {monogram(team.shortName)}
    </span>
  );
}
