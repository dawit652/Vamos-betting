import type { LeagueBadge } from '@/lib/badges';

/** Code size in the 24-unit disc, by the code's length. */
const CODE_SIZE: Readonly<Record<number, number>> = { 1: 13, 2: 10.5, 3: 8.2 };

/**
 * A competition's mark where the flag stands: its country flag (emoji), or for a competition with
 * no country (the Champions League, the World Cup...) its logo on a white tile (readable on the
 * dark theme too), or our drawn disc when we have no logo for it. Sized in em like the emoji it
 * replaces; decorative (the competition's name is next to it).
 */
export function LeagueIcon({
  flag,
  badge,
  className,
}: {
  flag: string;
  badge: LeagueBadge | null;
  className?: string;
}) {
  if (badge === null) {
    return (
      <span aria-hidden="true" className={className}>
        {flag}
      </span>
    );
  }
  if (badge.kind === 'logo') {
    return (
      <span
        aria-hidden="true"
        className={`inline-flex h-[1.25em] w-[1.25em] flex-none items-center justify-center rounded-[0.3em] bg-white p-[0.08em] ring-1 ring-black/10 ${className ?? ''}`}
      >
        {/* A 96 px file of our own, shown at icon size: next/image would add nothing here. */}
        <img
          src={badge.src}
          alt=""
          width={24}
          height={24}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-contain"
        />
      </span>
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width="1.25em"
      height="1.25em"
      aria-hidden="true"
      focusable="false"
      className={`inline-block flex-none ${className ?? ''}`}
    >
      <circle cx="12" cy="12" r="12" fill={badge.bg} />
      <circle
        cx="12"
        cy="12"
        r="10.4"
        fill="none"
        stroke={badge.fg}
        strokeOpacity="0.4"
        strokeWidth="0.8"
      />
      {badge.kind === 'cup' ? (
        <g fill={badge.fg}>
          <path d="M8.4 6.4h7.2v3.3a3.6 3.6 0 0 1-7.2 0z" />
          <path
            d="M8.4 7.5H6.9a1.7 1.7 0 0 0 0 3.4h1.9M15.6 7.5h1.5a1.7 1.7 0 0 1 0 3.4h-1.9"
            fill="none"
            stroke={badge.fg}
            strokeWidth="1"
          />
          <rect x="11.2" y="13.2" width="1.6" height="2.6" />
          <rect x="8.8" y="15.8" width="6.4" height="1.8" rx="0.6" />
        </g>
      ) : (
        <text
          x="12"
          y="12.4"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={CODE_SIZE[badge.label.length] ?? 7}
          fontWeight="800"
          letterSpacing="-0.2"
          fill={badge.fg}
        >
          {badge.label}
        </text>
      )}
    </svg>
  );
}
