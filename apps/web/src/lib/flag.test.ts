import { describe, expect, it } from 'vitest';
import { flagEmoji } from './flag';

describe('flagEmoji', () => {
  it('builds regional-indicator pairs, case-insensitively', () => {
    expect(flagEmoji('GB')).toBe('\u{1F1EC}\u{1F1E7}');
    expect(flagEmoji('et')).toBe('\u{1F1EA}\u{1F1F9}');
  });

  it('gives the globe for null, undefined or invalid codes', () => {
    for (const code of [null, undefined, '', 'G', 'GBR', 'G1', '1G', ' G', 'ÄB']) {
      expect(flagEmoji(code)).toBe('\u{1F30D}');
    }
  });
});
