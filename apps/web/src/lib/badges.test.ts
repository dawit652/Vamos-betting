import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOGO_SOURCES, initials, leagueBadge, type LeagueBadge } from './badges';
import { AMERICAS, ASIA, EUROPE, GLOBE, WORLD, flagEmoji } from './flag';

const badge = (slug: string, name: string, flag: string = WORLD) =>
  leagueBadge({ slug, name: { en: name } }, flag);
const logoOf = (b: LeagueBadge | null) => (b?.kind === 'logo' ? b.src : null);
const codeOf = (b: LeagueBadge | null) => (b?.kind === 'code' ? b.label : null);

describe('leagueBadge', () => {
  it('leaves a country flag alone', () => {
    expect(badge('premier-league', 'Premier League', flagEmoji('GB-ENG'))).toBeNull();
    expect(badge('ethiopian-premier-league', 'Premier League', flagEmoji('ET'))).toBeNull();
    // A domestic "Champions League" with a flag keeps its flag.
    expect(badge('hl-kenya-cl', 'Champions League', flagEmoji('KE'))).toBeNull();
  });

  it('shows the logo of a known competition, by slug or by English name', () => {
    expect(logoOf(badge('uefa-champions-league', 'UEFA Champions League', EUROPE))).toBe(
      '/league-logos/uefa-champions-league.png',
    );
    expect(logoOf(badge('hl-1234', 'Champions League'))).toBe(
      '/league-logos/uefa-champions-league.png',
    );
    expect(logoOf(badge('uefa-europa-league', 'UEFA Europa League', EUROPE))).toBe(
      '/league-logos/uefa-europa-league.png',
    );
    expect(logoOf(badge('hl-77', 'UEFA Europa Conference League'))).toBe(
      '/league-logos/uefa-conference-league.png',
    );
    expect(logoOf(badge('uefa-nations-league', 'UEFA Nations League', EUROPE))).toBe(
      '/league-logos/uefa-nations-league.png',
    );
    expect(logoOf(badge('caf-champions-league', 'CAF Champions League', GLOBE))).toBe(
      '/league-logos/caf.png',
    );
    expect(logoOf(badge('caf-confederation-cup', 'CAF Confederation Cup', GLOBE))).toBe(
      '/league-logos/caf.png',
    );
    expect(logoOf(badge('afc-champions-league', 'AFC Champions League Elite', ASIA))).toBe(
      '/league-logos/afc-champions-league.png',
    );
    expect(logoOf(badge('copa-libertadores', 'Copa Libertadores', AMERICAS))).toBe(
      '/league-logos/conmebol-libertadores.png',
    );
    expect(logoOf(badge('fifa-world-cup', 'FIFA World Cup'))).toBe(
      '/league-logos/fifa-world-cup.svg',
    );
    expect(logoOf(badge('africa-cup-of-nations', 'Africa Cup of Nations', GLOBE))).toBe(
      '/league-logos/africa-cup-of-nations.png',
    );
    expect(logoOf(badge('afcon-qualifiers', 'Africa Cup of Nations Qualification'))).toBe(
      '/league-logos/africa-cup-of-nations.png',
    );
  });

  it('shows each confederation’s logo on its World Cup qualifiers, a code elsewhere', () => {
    expect(logoOf(badge('wc-qualification-caf', 'World Cup Qualification CAF'))).toBe(
      '/league-logos/caf.png',
    );
    expect(logoOf(badge('hl-9', 'World Cup Qualification South America'))).toBe(
      '/league-logos/conmebol.png',
    );
    expect(logoOf(badge('hl-10', 'World Cup Qualification Asia'))).toBe(
      '/league-logos/afc-asian-qualifiers.png',
    );
    expect(codeOf(badge('hl-11', 'World Cup Qualification Europe'))).toBe('WCQ');
  });

  it('draws a badge where we have no usable logo (out of date, or a text banner)', () => {
    expect(badge('uefa-euro', 'UEFA Euro 2028', EUROPE)?.kind).toBe('cup');
    expect(badge('copa-america', 'Copa América', AMERICAS)?.kind).toBe('cup');
    expect(codeOf(badge('uefa-euro-2028-qualifying', 'UEFA Euro 2028 Qualifying', EUROPE))).toBe(
      'EQ',
    );
    expect(codeOf(badge('fifa-club-world-cup', 'FIFA Club World Cup'))).toBe('CWC');
    expect(codeOf(badge('international-friendlies', 'International Friendlies'))).toBe('INT');
    expect(codeOf(badge('club-friendlies', 'Club Friendlies'))).toBe('CF');
  });

  it('keeps the other confederations out of UEFA’s logos', () => {
    expect(codeOf(badge('ofc-champions-league', 'OFC Champions League'))).toBe('OCL');
    expect(logoOf(badge('concacaf-nations-league', 'CONCACAF Nations League'))).toBe(
      '/league-logos/concacaf-nations-league.png',
    );
    // Any other CAF competition: the CAF logo.
    expect(logoOf(badge('caf-super-cup', 'CAF Super Cup', GLOBE))).toBe('/league-logos/caf.png');
  });

  it('gives any other competition without a flag its initials, same colour every time', () => {
    const first = badge('hl-other-league', 'Mystery Cup');
    expect(codeOf(first)).toBe('MC');
    expect(badge('hl-other-league', 'Mystery Cup')).toEqual(first);
    expect(badge('uefa-u21-championship', 'UEFA U21 Championship', EUROPE)).toEqual({
      kind: 'code',
      label: 'U21',
      bg: '#0b1f5c',
      fg: '#ffffff',
    });
  });

  it('points only at logo files that exist', () => {
    const publicDir = join(__dirname, '../../public');
    const files = [
      ...Object.keys(LOGO_SOURCES).map((name) => `/league-logos/${name}.png`),
      '/league-logos/fifa-world-cup.svg',
    ];
    for (const file of files) expect(existsSync(join(publicDir, file)), file).toBe(true);
  });
});

describe('initials', () => {
  it('makes a short code of the name', () => {
    expect(initials('Premier League Cup')).toBe('PLC');
    expect(initials('The Cup of Nations')).toBe('CN');
    expect(initials('Eliteserien')).toBe('EL');
    expect(initials('Primera División de México')).toBe('PDM');
    expect(initials('')).toBe('?');
    expect(initials('---')).toBe('?');
  });
});
