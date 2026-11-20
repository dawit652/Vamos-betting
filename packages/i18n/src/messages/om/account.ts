import type { DeepPartial } from '../../fallback';
import type { Messages } from '../en';

// Afaan Oromoo. UNREVIEWED: untranslated keys fall back to English (see ./index.ts).
export const account: DeepPartial<Messages['account']> = {
  payments: {
    cashAtShop: {
      title: 'Maallaqa shaakkalaa irratti baasuu',
      intro:
        'Koodii shaakkalaa argadhu, achiis lakkoofsa bilbilaa fi koodii kaffaltootaaf himi. ID kee fudhadhu. Koodiin daqiiqaa 15 hojiirra oola.',
      get: 'Koodii shaakkalaa argadhu',
      getNew: 'Koodii haaraa argadhu',
      codeLabel: 'Koodii shaakkalaa kee',
      validUntil: 'hanga {time} tti hojiirra oola',
      remaining: 'Yeroo hafe: {time}',
    },
  },
};
