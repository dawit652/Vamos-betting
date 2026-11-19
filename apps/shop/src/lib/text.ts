/**
 * Every string the shop app shows, in one place: English with the Amharic next to the main
 * headings and buttons ("Sign in · ግባ"). Counter staff read these on a PC or a small POS screen.
 */
export const TEXT = {
  appName: 'Nahubet Shop · ናሁቤት ሱቅ',
  loading: 'Loading… · በመጫን ላይ…',
  email: 'Email · ኢሜይል',
  password: 'Password · የይለፍ ቃል',

  signIn: 'Sign in · ግባ',
  signingIn: 'Signing in…',
  signOut: 'Sign out · ውጣ',
  loginFailed: 'Wrong email or password, or this device is not registered yet.',
  registerDeviceLink: 'Register this device',

  registerTitle: 'Register this device · መሣሪያን መመዝገብ',
  deviceName: 'Device name · የመሣሪያ ስም',
  deviceNamePlaceholder: 'Counter PC 1',
  registerButton: 'Ask for approval · ፈቃድ ጠይቅ',
  registerSending: 'Asking…',
  registerDone: "Asked. An admin must approve this device on the agent's page; then sign in.",
  backToSignIn: 'Back to sign in',
  registerErrors: {
    shop_assignment_required: 'This account has no shop yet. Ask an admin to assign one.',
    too_many_device_requests:
      'Too many devices are waiting for approval at this shop. Ask an admin to approve or revoke some.',
    agent_blocked: 'This agent is blocked. Ask the head office.',
    shop_inactive: 'This shop is closed. Ask an admin to reopen it.',
    invalid_device_label: 'Give the device a short name, up to 60 characters.',
    invalid_credentials: 'Wrong email or password.',
  } as Readonly<Record<string, string>>,

  passwordTitle: 'Choose a new password · አዲስ የይለፍ ቃል',
  passwordForced:
    'Your password was set by an admin. Choose your own before you start. At least 12 characters.',
  passwordHint: 'At least 12 characters.',
  currentPassword: 'Current password · አሁን ያለው የይለፍ ቃል',
  newPassword: 'New password · አዲስ የይለፍ ቃል',
  repeatPassword: 'New password again · አዲሱን እንደገና',
  passwordSave: 'Save password · አስቀምጥ',
  passwordSaving: 'Saving…',
  passwordTooShort: 'The new password needs at least 12 characters.',
  passwordMismatch: 'The two new passwords are not the same.',
  passwordErrors: {
    reauth_failed: 'The current password is wrong.',
    weak_password: 'This password is too easy to guess. Choose a longer or less common one.',
    password_unchanged: 'The new password must differ from the current one.',
  } as Readonly<Record<string, string>>,

  deskTitle: 'Desk · ዴስክ',
  navDesk: 'Desk · ዴስክ',
  navPrinter: 'Printer · ህትመት',
  navPassword: 'Password · የይለፍ ቃል',
  cashier: 'Cashier',
  noShift: 'No shift is open.',
  openShiftTitle: 'Open shift · ፈረቃ ክፈት',
  openingFloat: 'Opening float, ETB · መነሻ ገንዘብ',
  openShiftButton: 'Open shift · ክፈት',
  openShiftBusy: 'Opening…',
  floatInvalid: 'Enter the cash in the drawer as ETB, for example 1,500 or 1500.50.',
  shiftTitle: 'Open shift · የተከፈተ ፈረቃ',
  openedAt: 'Opened',
  float: 'Float',
  deposits: 'Deposits',
  withdrawals: 'Withdrawals',
  expectedCash: 'Expected cash',
  closeShiftTitle: 'Close shift · ፈረቃ ዝጋ',
  countedCash: 'Counted cash, ETB · የተቆጠረ ገንዘብ',
  counted: 'Counted',
  closeNote: 'Note (optional) · ማስታወሻ',
  closeShiftButton: 'Close shift · ዝጋ',
  closeShiftBusy: 'Closing…',
  countInvalid: 'Enter the cash you counted as ETB, for example 2,340 or 2340.50.',
  closedSummary: 'Shift closed',
  variance: 'Difference',
  receiptsTitle: 'Receipts · ደረሰኞች',
  noReceipts: 'No receipts in this shift yet.',
  colTime: 'Time',
  colReceipt: 'Receipt',
  colKind: 'Kind',
  colAmount: 'Amount',
  colPlayer: 'Player',
  kind: { deposit: 'Deposit', withdrawal: 'Withdrawal' } as Readonly<Record<string, string>>,
  sellingSoon: 'Selling tickets comes soon.',
  deskErrors: {
    shift_already_open: 'A shift is already open. Reload the page.',
  } as Readonly<Record<string, string>>,

  printerTitle: 'Receipt printer · የደረሰኝ አታሚ',
  printerGuide: [
    "Install the thermal printer's Windows driver and make it the default printer.",
    'In the print dialog choose margins None and scale 100%.',
    'Set the paper to the shop width shown below (58 or 80 mm roll).',
    'To print without the dialog, start Chrome or Edge with --kiosk-printing.',
  ],
  printerWidth: 'Paper width of this shop',
  printTest: 'Print a test receipt · የሙከራ ህትመት',
  testPrintNote: 'Nothing is saved by the test: no receipt, no money moves.',
  testReceiptTitle: 'TEST PRINT · Not a receipt',
  testReceiptAmharic: 'የሙከራ ህትመት',
  testReceiptChars: '0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  testReceiptFooter: 'If every line above is complete, the printer is ready.',

  networkError: 'The server could not be reached. Check the internet connection.',
  genericError: 'Something went wrong. Try again.',
  rateLimited: 'Too many attempts. Wait a moment and try again.',
  csrfInvalid: 'Your session needs a refresh. Reload the page.',
  passwordChangeRequired: 'Choose your own password first.',
} as const;

/** The paper size line printed on the test receipt. */
export function paperWidthLabel(widthMm: 58 | 80): string {
  return `Paper width ${widthMm} mm`;
}
