import { countryCodeOfName } from '@vamos/core';

/**
 * Which teams of an event show a country flag (owner, 17 Nov 2026: "teams flags or their logo
 * along with their names in every match"). National teams take their flag; clubs have no logo
 * source yet, so they keep a crest with their initials (the caller's fallback).
 *
 * An event is a national-team event when both teams are countries (Israel v Italy, Kyrgyzstan v
 * Vietnam, with U19 or Women after the name), or one is and the competition is an international
 * one that is not for clubs. A club called like a country (AS "Monaco") therefore keeps its crest
 * in its league, in the Champions League and in club friendlies.
 */

interface EventNames {
  competition: { name: { en: string }; category: { en: string } };
  home: { name: { en: string } };
  away: { name: { en: string } };
}

/** Categories of national-team competitions (not "International Clubs"). */
const INTERNATIONAL_CATEGORY =
  /^(international|world|europe|africa|asia|south america|north america|oceania|concacaf|conmebol)\b/i;

/** Competitions of clubs, whatever their category is called. */
const CLUB_COMPETITION =
  /champions|europa|conference league|libertadores|sudamericana|confederation cup|super cup|club/i;

/** The flag code of the home and away team, null where the team keeps its crest. */
export function teamFlagCodes(event: EventNames): readonly [string | null, string | null] {
  const home = countryCodeOfName(event.home.name.en);
  const away = countryCodeOfName(event.away.name.en);
  if (home === null && away === null) return [null, null];
  const international =
    INTERNATIONAL_CATEGORY.test(event.competition.category.en.trim()) &&
    !/clubs?/i.test(event.competition.category.en) &&
    !CLUB_COMPETITION.test(event.competition.name.en);
  const national = (home !== null && away !== null) || international;
  return national ? [home, away] : [null, null];
}
