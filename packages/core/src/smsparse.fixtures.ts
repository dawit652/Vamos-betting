/**
 * Confirmation SMS shapes, pinned (scrubbed of real names and numbers).
 *
 * When a deposit lands in the review queue as `unparsed`, copy its raw text
 * here (scrubbed), add an expectation in `smsparse.test.ts`, and extend the
 * shared markers or that institution's spec until it passes. Before go-live,
 * replace the telebirr and CBE shapes with real messages from the collection
 * accounts (docs/runbooks/sms-rail.md).
 */

export const TELEBIRR_SMS = {
  creditEnglish:
    'Dear CUSTOMER, you have received ETB 100.37 from SENDER NAME (251900000000) on 15/08/2026 at 3:31:00 PM. Your transaction number is CA999DASAD. Your telebirr balance is ETB 1,234.56. To get your transaction receipt click https://transactioninfo.ethiotelecom.et/receipt/CA999DASAD',
  debitEnglish:
    'Dear CUSTOMER, you have transferred ETB 500.00 to RECIPIENT NAME (251900000001) on 15/08/2026 at 4:00:00 PM. Your transaction number is CB123XYZ99. Your telebirr balance is ETB 734.56.',
  creditAmharic: 'ውድ ደንበኛችን፣ ከ SENDER ብር 100.37 ተቀብለዋል። የግብይት ቁጥር: CA999DASAD',
  /** No counterparty number, no receipt link: the sparse variant. */
  creditMinimal:
    'You have received ETB 75.42 on 15/08/2026. Your transaction number is CD456QWERT.',
  /**
   * The Amharic credit as telebirr actually sends it (collection handset, 22 Nov 2026; names,
   * numbers and the reference changed): a masked payer number, the reference after
   * "የሂሳብ እንቅስቃሴ ቁጥርዎ", the date after "በ".
   */
  creditAmharicLive:
    'ውድ CUSTOMER \nከ sender name(2519****0000) 10.73 ብር በ 22/11/2026 23:53:23 ተቀብለዋል፡፡ የሂሳብ እንቅስቃሴ ቁጥርዎ DKA1BC2DEF ነዉ፡፡ አሁን ያለዎት ቀሪ ሂሳብ  1,234.56 ብር ነዉ፡፡ \nበቴሌብር ስለተገለገሉ እናመሰግናለን \nኢትዮ ቴሌኮም',
} as const;

export const CBE_SMS = {
  creditEnglish:
    'Dear Customer, You have received ETB 250.00 from SENDER NAME on 15/08/2026. Your account balance is ETB 3,400.00. Ref No CAA2K819ZY https://apps.cbe.com.et:100/?id=CAA2K819ZY',
  debitEnglish:
    'Dear Customer, Your account has been debited with ETB 150.00 on 15/08/2026. Ref No FT26227ABCD',
  /**
   * The credit as CBE actually sends it (collection handset, 22 Nov 2026; names, accounts and the
   * token changed): no "Ref No", only the receipt link's token, the payer's masked account and name.
   */
  creditLive:
    'Dear CUSTOMER NAME You have received ETB 50.28 from account 1********0000 (Sender Full Name) to your account 1********1111. Your current balance is ETB 1,234.56. Thanks for Banking with CBE. https://mbreciept.cbe.com.et/v2-abCDefGH12ijKL34mnOP for feedback: https://forms.gle/AbCdEf12345',
  /**
   * Money sent from telebirr to the CBE account, as CBE reports it (22 Nov 2026; name, accounts
   * and the reference changed): one decimal, no thousands comma, the FT reference only in the
   * BranchReceipt link.
   */
  creditFromWalletLive:
    'Dear CUSTOMER NAME your Account 1****1111 has been credited with ETB 10.4. Your Current Balance is ETB 1234.56. Thank you for Banking with CBE! for Reciept https://apps.cbe.com.et:100/BranchReceipt/FT26001ABC12&11111111',
} as const;

export const BANK_SMS = {
  awash:
    'Dear Customer, Your account 013xxxxxxx has been credited with ETB 300.45 from ABEBE KEBEDE on 15/08/2026. Your current balance is ETB 5,000.00. Ref: AWB123456789',
  abyssinia:
    'Dear customer, ETB 450.22 has been credited to your account 12345678 on 15/08/2026. Available balance ETB 2,100.50. Ref No BOA9988776',
  coop: 'Your account has been credited with Birr 120.33 on 15/08/2026. Ref CBO202608150001. Balance Birr 890.00',
  amole:
    'You have received ETB 75.19 from TIGIST on 15/08/2026. Transaction ID: AML55667788. Your balance is ETB 400.00',
  mpesa:
    'CONFIRMED. You have received ETB 200.66 from CHALTU BEKELE 0712345678 on 15/08/2026 at 2:00 PM. New M-PESA balance is ETB 1,000.00. Ref QGH7TR8901',
  amharic: 'ውድ ደንበኛችን፣ ወደ ሂሳብዎ ብር 640.28 ገቢ ተደርጓል። ቀሪ ሂሳብ ብር 1,500.00። የግብይት ቁጥር: AMB2026081501',
  bankDebit:
    'Dear Customer, Your account 013xxxxxxx has been debited with ETB 800.00 on 15/08/2026. Ref AWB999888777',
  /**
   * The balance comes before the payment: taking the first currency figure
   * would credit 5,000.00 instead of 250.75.
   */
  balanceFirst:
    'Your balance is ETB 5,000.00 after your account was credited with ETB 250.75 on 15/08/2026. Ref TST123456',
  /** An account number containing a 9-digit run must not be read as a phone. */
  accountWithNineRun:
    'Dear Customer, Your account 1000912345678 has been credited with ETB 90.10 on 15/08/2026. Ref FT26227QQQQ',
} as const;

/** Messages that must not parse: promotions, OTPs, unrelated traffic, unsafe shapes. */
export const NOISE_SMS = [
  'Get 100 ETB bonus today! Dial *123# now.',
  'Your verification code is 445566. Do not share it.',
  'hello how are you',
  '',
  // An amount and a reference but no direction marker: unsafe to guess.
  'ETB 100.00 transaction number is CA999DASAD',
  // Both directions at once: unsafe to guess.
  'You have received ETB 10.00 and you have transferred ETB 10.00. Ref AAA111222',
  // A decimal comma would otherwise read as 10,037 birr.
  'You have received ETB 100,37 from X. Ref ZZZ999888',
] as const;
