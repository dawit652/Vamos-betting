import type { DeepPartial } from '../../fallback';
import type { Messages } from '../en';

// Tigrinya. UNREVIEWED: untranslated keys fall back to English (see ./index.ts).
export const account: DeepPartial<Messages['account']> = {
  payments: {
    cashAtShop: {
      title: 'ብሱቕ ጥረ ገንዘብ ምውጻእ',
      intro: 'ናይ ሱቕ ኮድ ረኺብኩም፡ ድሕሪኡ ንከፋሊ ቁጽሪ ተሌፎንኩምን ኮዱን ንገርዎ። መንነትኩም ሒዝኩም ኪዱ። እቲ ኮድ ን15 ደቒቕ ይሰርሕ።',
      get: 'ናይ ሱቕ ኮድ ረኽቡ',
      getNew: 'ሓድሽ ኮድ ረኽቡ',
      codeLabel: 'ናይ ሱቕ ኮድኩም',
      validUntil: 'ክሳብ {time} ይሰርሕ',
      remaining: 'ዝተረፈ ጊዜ፦ {time}',
    },
  },
};
