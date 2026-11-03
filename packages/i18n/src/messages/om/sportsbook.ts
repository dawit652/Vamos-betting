import type { DeepPartial } from '../../fallback';
import type { Messages } from '../en';

// Afaan Oromoo. UNREVIEWED: untranslated keys fall back to English (see ./index.ts).
export const sportsbook: DeepPartial<Messages['sportsbook']> = {
  match: {
    oddsUpdated: "Odds'iin daqiiqaa {minutes} dura haaromfame",
    oddsUpdatedNow: "Odds'iin amma haaromfame",
    simulated: "Odds'iin fakkeenyaa",
  },
};
