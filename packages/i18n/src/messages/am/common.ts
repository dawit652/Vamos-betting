import type { Messages } from '../en';

// Amharic. Pending native-speaker review before a licensed launch.
export const common: Messages['common'] = {
  app: {
    name: 'ናሁቤት',
    tagline: 'ቀላል የስፖርት ውርርድ',
  },
  demo: {
    banner: 'የሙከራ ሁነታ – በእውነተኛ ገንዘብ አይደለም።',
    badge: 'ሙከራ',
  },
  rg: {
    ageNotice: 'ዕድሜያቸው 21 እና ከዚያ በላይ ለሆኑ ብቻ። በኃላፊነት ይወራረዱ።',
  },
  nav: {
    home: 'መነሻ',
    live: 'ቀጥታ',
    jackpot: 'ጃክፖት',
    myBets: 'የእኔ ውርርዶች',
    account: 'መለያ',
    wallet: 'ቦርሳ',
    help: 'እገዛ',
    terms: 'ውሎች',
    privacy: 'ግላዊነት',
    responsibleGambling: 'ኃላፊነት የተሞላበት ውርርድ',
    main: 'ዋና ማውጫ',
    sports: 'ስፖርቶች',
  },
  header: {
    login: 'ግባ',
    register: 'ተመዝገብ',
    balance: 'ቀሪ ሂሳብ',
    balanceLabel: 'ቀሪ ሂሳብ፦ {amount}',
  },
  sports: {
    football: 'እግር ኳስ',
    basketball: 'ቅርጫት ኳስ',
    tennis: 'ቴኒስ',
    volleyball: 'መረብ ኳስ',
  },
  actions: {
    save: 'አስቀምጥ',
    cancel: 'ሰርዝ',
    close: 'ዝጋ',
    retry: 'እንደገና ሞክር',
    back: 'ተመለስ',
    confirm: 'አረጋግጥ',
    continue: 'ቀጥል',
    submit: 'ላክ',
    loading: 'በመጫን ላይ…',
    logout: 'ውጣ',
    showMore: 'ተጨማሪ አሳይ',
  },
  betslip: {
    button: 'የውርርድ ወረቀት',
    count: '{count} ምርጫዎች',
    limitReached: 'አንድ የውርርድ ወረቀት ቢበዛ {max} ምርጫዎች ብቻ ይይዛል።',
  },
  language: {
    label: 'ቋንቋ',
    switchTo: 'ወደ {language} ቀይር',
    unreviewed: 'ትርጉሙ ገና አልተገመገመም',
  },
  errors: {
    generic: 'የሆነ ችግር ተፈጥሯል። እባክዎ እንደገና ይሞክሩ።',
    network: 'ግንኙነት የለም። ኢንተርኔትዎን አረጋግጠው እንደገና ይሞክሩ።',
    unauthorized: 'እባክዎ መጀመሪያ ይግቡ።',
    sessionExpired: 'ክፍለ ጊዜዎ አብቅቷል። ገጹን አድሰው እንደገና ይሞክሩ።',
    validation: 'ያስገቡትን መረጃ ያረጋግጡ።',
    rateLimited: 'በጣም ብዙ ሙከራዎች። ትንሽ ቆይተው እንደገና ይሞክሩ።',
    notFound: 'አልተገኘም።',
    server: 'አገልግሎቱ ለጊዜው አይገኝም። ትንሽ ቆይተው ይሞክሩ።',
  },
};
