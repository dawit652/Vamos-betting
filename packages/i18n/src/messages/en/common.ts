/**
 * Shared UI text: app shell, navigation, buttons, errors.
 * English is the source locale: these shapes define the `Messages` type.
 * Placeholders use `{name}` and must appear unchanged in every locale.
 */
export const common = {
  app: {
    name: 'Nahubet',
    tagline: 'Sports betting made simple',
  },
  demo: {
    banner: 'DEMO – play money only. No real money is used.',
    badge: 'DEMO',
  },
  rg: {
    ageNotice: '21+ only. Bet responsibly.',
  },
  nav: {
    home: 'Home',
    live: 'Live',
    myBets: 'My Bets',
    jackpot: 'Jackpot',
    account: 'Account',
    wallet: 'Wallet',
    help: 'Help',
    terms: 'Terms',
    privacy: 'Privacy',
    responsibleGambling: 'Responsible gambling',
    main: 'Main navigation',
    sports: 'Sports',
  },
  header: {
    login: 'Log in',
    register: 'Register',
    balance: 'Balance',
    balanceLabel: 'Balance: {amount}',
  },
  sports: {
    football: 'Football',
    basketball: 'Basketball',
    tennis: 'Tennis',
    volleyball: 'Volleyball',
  },
  actions: {
    save: 'Save',
    cancel: 'Cancel',
    close: 'Close',
    retry: 'Try again',
    back: 'Back',
    confirm: 'Confirm',
    continue: 'Continue',
    submit: 'Submit',
    loading: 'Loading…',
    logout: 'Log out',
    showMore: 'Show more',
  },
  betslip: {
    button: 'Betslip',
    count: '{count} selections',
    limitReached: 'A betslip can hold at most {max} selections.',
  },
  language: {
    label: 'Language',
    switchTo: 'Switch to {language}',
    unreviewed: 'Translation not yet reviewed',
  },
  errors: {
    generic: 'Something went wrong. Please try again.',
    network: 'No connection. Check your internet and try again.',
    unauthorized: 'Please log in first.',
    sessionExpired: 'Your session has expired. Reload the page and try again.',
    validation: 'Please check the details you entered.',
    rateLimited: 'Too many attempts. Please wait a moment and try again.',
    notFound: 'Not found.',
    server: 'The service is temporarily unavailable. Please try again shortly.',
  },
} as const;
