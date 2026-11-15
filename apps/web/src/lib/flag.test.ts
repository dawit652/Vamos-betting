import { describe, expect, it } from 'vitest';
import { AFRICA, AMERICAS, ASIA, EUROPE, GLOBE, WORLD, competitionFlag, flagEmoji } from './flag';

const tagFlag = (tags: string) =>
  String.fromCodePoint(0x1f3f4, ...[...tags].map((c) => 0xe0061 + c.charCodeAt(0) - 97), 0xe007f);

describe('flagEmoji', () => {
  it('builds regional-indicator pairs, case-insensitively', () => {
    expect(flagEmoji('GB')).toBe('\u{1F1EC}\u{1F1E7}');
    expect(flagEmoji('et')).toBe('\u{1F1EA}\u{1F1F9}');
  });

  it('gives the globe for null, undefined or invalid codes', () => {
    for (const code of [null, undefined, '', 'G', 'GBR', 'G1', '1G', ' G', 'ÄB', 'GB-', '-GB']) {
      expect(flagEmoji(code)).toBe(GLOBE);
    }
  });

  it('gives England, Scotland and Wales their own flags', () => {
    expect(flagEmoji('GB-ENG')).toBe(tagFlag('gbeng'));
    expect(flagEmoji('GB-SCT')).toBe(tagFlag('gbsct'));
    expect(flagEmoji('GB-WLS')).toBe(tagFlag('gbwls'));
    expect(flagEmoji('GB-ENG')).toBe(
      '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
    );
  });

  it('gives Northern Ireland the UK flag', () => {
    expect(flagEmoji('GB-NIR')).toBe('\u{1F1EC}\u{1F1E7}');
  });

  it('gives an unknown subdivision its country flag', () => {
    expect(flagEmoji('ES-CT')).toBe('\u{1F1EA}\u{1F1F8}');
  });

  it('is case-insensitive for subdivisions', () => {
    expect(flagEmoji('gb-eng')).toBe(tagFlag('gbeng'));
    expect(flagEmoji('Gb-Sct')).toBe(tagFlag('gbsct'));
    expect(flagEmoji('es-ct')).toBe('\u{1F1EA}\u{1F1F8}');
  });
});

describe('competitionFlag', () => {
  const intl: { slug: string; countryCode: string | null } = {
    slug: 'international',
    countryCode: null,
  };
  const flag = (slug: string, category: { slug: string; countryCode: string | null } = intl) =>
    competitionFlag({ slug }, category);

  it('gives UEFA competitions the EU flag', () => {
    for (const slug of ['uefa-champions-league', 'uefa-europa-league', 'uefa-conference-league']) {
      expect(flag(slug, { slug: 'international-clubs', countryCode: null })).toBe(EUROPE);
    }
    expect(EUROPE).toBe('\u{1F1EA}\u{1F1FA}');
  });

  it('gives CAF competitions and the africa category the Africa globe', () => {
    expect(flag('caf-champions-league', { slug: 'africa', countryCode: null })).toBe(AFRICA);
    expect(flag('caf-confederation-cup')).toBe(AFRICA);
    expect(flag('afcon-qualifiers', { slug: 'africa', countryCode: null })).toBe(AFRICA);
  });

  it('gives the Americas their globe', () => {
    for (const slug of [
      'conmebol-qualifiers',
      'copa-libertadores',
      'copa-sudamericana',
      'concacaf-gold-cup',
    ]) {
      expect(flag(slug)).toBe(AMERICAS);
    }
  });

  it('gives AFC competitions the Asia globe', () => {
    expect(flag('afc-champions-league')).toBe(ASIA);
  });

  it('gives global competitions the world icon', () => {
    for (const slug of [
      'fifa-club-world-cup',
      'rugby-world-cup',
      'volleyball-nations-league',
      'int-friendlies',
      'club-friendlies',
      'atp-tour',
    ]) {
      expect(flag(slug)).toBe(WORLD);
    }
  });

  it('uses the category country for domestic leagues', () => {
    expect(flag('laliga', { slug: 'spain', countryCode: 'ES' })).toBe('\u{1F1EA}\u{1F1F8}');
    expect(flag('premier-league', { slug: 'england', countryCode: 'GB-ENG' })).toBe(
      tagFlag('gbeng'),
    );
  });

  it('gives a code-less unknown competition the world icon', () => {
    expect(flag('mystery-cup', { slug: 'nowhere', countryCode: null })).toBe(WORLD);
  });
});
