import type { DeepPartial } from '../../fallback';
import type { Messages } from '../en';

// Tigrinya. UNREVIEWED: untranslated keys fall back to English (see ./index.ts).
export const sportsbook: DeepPartial<Messages['sportsbook']> = {
  match: {
    oddsUpdated: 'ዕድላት ቅድሚ {minutes} ደቒቕ ተሓድሱ',
    oddsUpdatedNow: 'ዕድላት ሕጂ ተሓድሱ',
    simulated: 'ናይ ምስሌ ዕድላት',
  },
};
