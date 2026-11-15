import type { DeepPartial } from '../../fallback';
import type { Messages } from '../en';

// Tigrinya. UNREVIEWED: untranslated keys fall back to English (see ./index.ts).
export const common: DeepPartial<Messages['common']> = {
  app: {
    name: 'ናሁቤት',
    tagline: 'ቀሊል ናይ ስፖርት ውርርድ',
  },
  demo: {
    banner: 'ናይ ፈተና ኩነታት – ናይ ሓቂ ገንዘብ ኣይጥቀመን።',
  },
  rg: {
    ageNotice: 'ንዕድመኦም 21 ን ልዕሊኡን ጥራይ። ብሓላፍነት ተወራረዱ።',
  },
};
