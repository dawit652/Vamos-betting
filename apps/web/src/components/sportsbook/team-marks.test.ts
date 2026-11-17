import { describe, expect, it } from 'vitest';
import { teamFlagCodes } from './team-marks';

const match = (category: string, competition: string, home: string, away: string) => ({
  competition: { name: { en: competition }, category: { en: category } },
  home: { name: { en: home } },
  away: { name: { en: away } },
});

describe('teamFlagCodes', () => {
  it('gives national teams their flags, also with U19 or Women after the name', () => {
    expect(
      teamFlagCodes(match('International Youth', 'U19 UEFA European', 'Israel', 'Italy')),
    ).toEqual(['IL', 'IT']);
    expect(teamFlagCodes(match('International', 'Kings Cup', 'Tajikistan', 'Thailand'))).toEqual([
      'TJ',
      'TH',
    ]);
    expect(
      teamFlagCodes(match('International', 'Friendlies', 'Italy U21', 'England Women')),
    ).toEqual(['IT', 'GB-ENG']);
  });

  it('takes the flag of the one country when the other side is not in the table', () => {
    expect(teamFlagCodes(match('International', 'Friendlies', 'Brazil', 'Some Select XI'))).toEqual(
      ['BR', null],
    );
  });

  it('keeps crests for clubs, also for a club called like a country', () => {
    expect(teamFlagCodes(match('France', 'Ligue 1', 'Monaco', 'Lyon'))).toEqual([null, null]);
    expect(teamFlagCodes(match('England', 'Premier League', 'Chelsea', 'Arsenal'))).toEqual([
      null,
      null,
    ]);
    expect(
      teamFlagCodes(match('International Clubs', 'UEFA Champions League', 'Monaco', 'Real Madrid')),
    ).toEqual([null, null]);
    expect(teamFlagCodes(match('Europe', 'UEFA Europa League', 'Monaco', 'Roma'))).toEqual([
      null,
      null,
    ]);
    expect(teamFlagCodes(match('International', 'Club Friendlies', 'Monaco', 'Benfica'))).toEqual([
      null,
      null,
    ]);
  });
});
