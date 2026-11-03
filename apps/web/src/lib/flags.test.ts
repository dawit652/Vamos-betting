import { describe, expect, it } from 'vitest';
import { flagEmoji } from './flags';

describe('flagEmoji', () => {
  it('turns two-letter ISO codes into regional indicator pairs', () => {
    expect(flagEmoji('ES')).toBe('🇪🇸');
    expect(flagEmoji('et')).toBe('🇪🇹');
  });

  it('knows the UK home nations', () => {
    expect(flagEmoji('GB-ENG')).toBe('🏴󠁧󠁢󠁥󠁮󠁧󠁿');
    expect(flagEmoji('GB-SCT')).toBe('🏴󠁧󠁢󠁳󠁣󠁴󠁿');
    expect(flagEmoji('GB-WLS')).toBe('🏴󠁧󠁢󠁷󠁬󠁳󠁿');
  });

  it('falls back to a globe for regions and malformed codes', () => {
    for (const code of [null, undefined, '', 'EUR', 'GB-NIR', '1']) {
      expect(flagEmoji(code)).toBe('🌍');
    }
  });
});
