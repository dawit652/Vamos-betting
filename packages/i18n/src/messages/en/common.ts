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
    deposit: 'Deposit',
  },
  sports: {
    football: 'Football',
    basketball: 'Basketball',
    tennis: 'Tennis',
    volleyball: 'Volleyball',
  },
  telegram: {
    join: 'Join us on Telegram',
  },
  ticketCheck: {
    title: 'Check a shop ticket',
    intro: 'Type the number printed under the barcode of your ticket.',
    number: 'Ticket number',
    submit: 'Check',
    checking: 'Checking…',
    notFound: 'No shop ticket has this number. Check the number under the barcode.',
    error: 'The ticket cannot be checked right now. Try again in a minute.',
    soldAt: 'Sold at {shop}',
    open: 'Not settled yet: its matches are still to be played.',
    lost: 'This ticket lost.',
    payable: 'It won {amount}.',
    payableHow:
      'Collect it at the shop that sold it ({shop}): bring the ticket and say the payout code printed on it.',
    paid: 'Paid: {amount}.',
    expired: 'It expired without being collected.',
    cancelled: 'This ticket was cancelled.',
    secret: 'Never share your payout code: whoever has it with the ticket can collect the win.',
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
    odds: 'Odds',
    netPay: 'Net pay',
  },
  oddsMove: {
    up: 'odds up',
    down: 'odds down',
  },
  theme: {
    toLight: 'Switch to the light theme',
    toDark: 'Switch to the dark theme',
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
