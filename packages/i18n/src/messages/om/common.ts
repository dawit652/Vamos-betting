import type { DeepPartial } from '../../fallback';
import type { Messages } from '../en';

// Afaan Oromoo. UNREVIEWED: untranslated keys fall back to English (see ./index.ts).
export const common: DeepPartial<Messages['common']> = {
  app: {
    name: 'Vamos',
    tagline: 'Qabsiisa ispoortii salphaa',
  },
  demo: {
    banner: 'Haala yaalii – maallaqa dhugaa hin fayyadamu.',
  },
  rg: {
    ageNotice: 'Umuriin 21 fi isaa ol qofa. Itti gaafatamummaan qabsiisaa.',
  },
};
