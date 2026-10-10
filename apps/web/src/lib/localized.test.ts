import { describe, expect, it } from 'vitest';
import { localName } from './localized';

describe('localName', () => {
  it('prefers the UI locale and falls back to English', () => {
    const name = { en: 'Saint George', am: 'ቅዱስ ጊዮርጊስ', om: ' ' };
    expect(localName(name, 'am')).toBe('ቅዱስ ጊዮርጊስ');
    expect(localName(name, 'en')).toBe('Saint George');
    expect(localName(name, 'om')).toBe('Saint George');
    expect(localName(name, 'ti')).toBe('Saint George');
    expect(localName(null, 'am')).toBe('');
  });
});
