import { factoryMarket } from './market-factory';
import { isFactoryOnlyMarketType } from './market-resolve';
import { MARKET_TYPES, type MarketTypeCode, selectionLabel } from './markets';

/**
 * Player-facing names and bet-slip labels for the market factory's markets (plan task 2.4, first
 * part). Today's nine legacy types keep exactly what `MARKET_TYPES` and `selectionLabel` give;
 * every other market is named from the factory catalogue.
 *
 * Amharic: native-speaker translation of the factory-only labels is PENDING (see
 * {@link FACTORY_LABELS_AMHARIC_PENDING}, like the note at the top of markets.ts). Nothing here is
 * machine-translated: `am` equals the English text, except for a whole label that is one of
 * markets.ts's existing Amharic labels, which is reused verbatim ('Draw', 'Yes', 'No', 'Over 2.5',
 * "Arsenal or Draw", 'Any other score', ...). Combined labels stay English.
 */
export const FACTORY_LABELS_AMHARIC_PENDING = true;

export interface LocalizedLabel {
  en: string;
  am: string;
}

type Teams = { home: string; away: string };

function plain(text: string): LocalizedLabel {
  return { en: text, am: text };
}

/** A line as shown in a market name: handicap lines carry their sign ('+1.5', '-1'). */
function displayLine(type: string, line: string): string {
  if (/_(ah|eh)$/.test(type) && Number(line) > 0) return `+${line}`;
  return line;
}

/**
 * The market's player-facing name, with its line where it has one ("Total goals 2.5",
 * "Multigoals 1-3", "1st half double chance & total 1.5", "Half time / full time"). Today's nine
 * legacy types return exactly `MARKET_TYPES[type].name` (the catalogue views add no line to it).
 * Throws a RangeError for an unknown market or line.
 */
export function factoryMarketName(type: string, line?: string | null): LocalizedLabel {
  if (!isFactoryOnlyMarketType(type)) {
    if (Object.hasOwn(MARKET_TYPES, type)) {
      const { name } = MARKET_TYPES[type as MarketTypeCode];
      return { en: name.en, am: name.am };
    }
  }
  const market = factoryMarket(type, line);
  const base = market.name.replace(/ and total goals$/, ' & total').replace(/ and /g, ' & ');
  return plain(market.line === null ? base : `${base} ${displayLine(type, market.line)}`);
}

const PERIOD_WORDS: Readonly<Record<string, string>> = {
  '1st': '1st half',
  '2nd': '2nd half',
  equal: 'Equal',
  odd: 'Odd',
  even: 'Even',
};

/** One part of a selection code ('1', '1X', 'over', 'yes', '1-0', '2by3+', ...). */
function part(code: string, type: string, teams: Teams, line: string | null): LocalizedLabel {
  // Counts first: '1' and '2' are goal counts here, not teams.
  if (/^\d+\+?$/.test(code) && /exact_goals$/.test(type)) {
    return plain(code === '1' ? '1 goal' : `${code} goals`);
  }
  switch (code) {
    case '1':
    case 'X':
    case '2':
      return selectionLabel('1x2', code, teams);
    case '1X':
    case '12':
    case 'X2':
      return selectionLabel('dc', code, teams);
    case 'yes':
    case 'no':
      return selectionLabel('btts', code, teams);
    case 'over':
    case 'under': {
      if (line === null) throw new RangeError(`"${code}" needs a line`);
      const word = code === 'over' ? 'Over' : 'Under';
      return code === 'over'
        ? { en: `${word} ${line}`, am: `ከ${line} በላይ` }
        : { en: `${word} ${line}`, am: `ከ${line} በታች` };
    }
  }
  const period = PERIOD_WORDS[code];
  if (period !== undefined) return plain(period);
  if (code === 'other') {
    if (/(^|_)cs$/.test(type)) return selectionLabel('cs', 'other', teams);
    return plain('Any other');
  }
  const margin = /^([12])by(\d+\+?)$/.exec(code);
  if (margin !== null) {
    const side = margin[1] === '1' ? teams.home : teams.away;
    return plain(`${side} by ${margin[2]}`);
  }
  if (/^(\d+-\d+|\d+\+)$/.test(code) && /goal_range$/.test(type)) return plain(`${code} goals`);
  if (/^\d+-\d+$/.test(code)) return plain(code); // a score
  throw new RangeError(`no label for selection "${code}" of market "${type}"`);
}

function join(parts: readonly LocalizedLabel[], separator: string): LocalizedLabel {
  return plain(parts.map((p) => p.en).join(separator));
}

/**
 * A clear bet-slip label for a selection of a factory market: team names for team selections
 * ('1' is the home team, '2' the away team, '1X' "Home or Draw"), combinations joined readably
 * ("Arsenal & Yes", "Arsenal or Draw & Over 2.5", "Draw/Arsenal" for half time / full time,
 * "1-0/Arsenal" for a half-time score / full-time result), ranges ("2-3 goals", "4+ goals",
 * "Arsenal by 3+"), "Any other score" / "Any other". Today's nine legacy types delegate to
 * `selectionLabel` exactly. Throws a RangeError for an unknown market or selection.
 */
export function factorySelectionLabel(
  type: string,
  selection: string,
  teams: Teams,
  line?: string | null,
): LocalizedLabel {
  if (!isFactoryOnlyMarketType(type) && Object.hasOwn(MARKET_TYPES, type)) {
    return selectionLabel(type as MarketTypeCode, selection, teams, line);
  }
  const market = factoryMarket(type, line);
  if (!market.selections.includes(selection)) {
    throw new RangeError(`unknown selection "${selection}" for market "${type}"`);
  }
  const marketLine = market.line;
  if (/_(ah|eh)$/.test(type) && marketLine !== null) {
    return selectionLabel(/_ah$/.test(type) ? 'ah' : 'eh', selection, teams, marketLine);
  }
  const compose = (code: string): LocalizedLabel => {
    if (code.includes('&')) return join(code.split('&').map(compose), ' & ');
    // Half time / full time, half-time score / full-time result, and the half pairs.
    if (code.includes('/')) return join(code.split('/').map(compose), '/');
    return part(code, type, teams, marketLine);
  };
  return compose(selection);
}
