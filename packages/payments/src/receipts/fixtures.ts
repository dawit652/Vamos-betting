/**
 * Receipt pages, as bytes (ported from Melabingo).
 *
 * NOT_FOUND is verbatim what transactioninfo.ethiotelecom.et serves for an
 * unknown reference. The receipt bodies are reconstructed from the documented
 * field labels, not captured from a real payment: they pin the parser and the
 * four gates, but the label set must be confirmed against one real receipt
 * before go-live (docs/runbooks/sms-rail.md). When a receipt stops parsing,
 * the review queue row's receipt_raw holds what the institution served:
 * scrub it and add it here.
 */

/** Verbatim, 300 bytes, exactly what an unknown reference returns. */
export const NOT_FOUND = `<!DOCTYPE html>
<html lang="en">
<headr>
</header>
<body>
<div style="width:100%; height:50px; background-color:rgb(243, 241, 241); border:1px solid rgb(196, 189, 189); text-align: center; vertical-align: middle; padding-top: 30px;">
This request is not correct
</div>
</body>
<html>`;

/** A completed transfer of 100.37 into 0911678426. */
export const CREDIT_100_37 = `<!DOCTYPE html><html><head><title>Receipt</title>
<style>.t{width:100%}</style><script>var x=1;</script></head><body>
<table class="t">
  <tr><td>Payer Name</td><td>ABEBE K TESFAYE</td></tr>
  <tr><td>Payer telebirr no.</td><td>251912***789</td></tr>
  <tr><td>Credited Party name</td><td>DAWIT G</td></tr>
  <tr><td>Credited party account no</td><td>251911***426</td></tr>
  <tr><td>Transaction status</td><td>Completed</td></tr>
  <tr><td>Payment Date</td><td>27/08/2026 15:42</td></tr>
  <tr><td>transaction number is</td><td>CBE7XK2M91</td></tr>
  <tr><td>Service fee</td><td>ETB 0.00</td></tr>
  <tr><td>VAT</td><td>ETB 0.00</td></tr>
  <tr><td>total Paid Amount</td><td>ETB 100.37</td></tr>
</table></body></html>`;

/** Same shape, but the money went to a stranger. */
export const CREDIT_WRONG_RECEIVER = CREDIT_100_37.replace('251911***426', '251977***111').replace(
  'DAWIT G',
  'SOMEONE ELSE',
);

/** Reference on the page disagrees with the one we looked up. */
export const CREDIT_WRONG_REFERENCE = CREDIT_100_37.replace('CBE7XK2M91', 'ZZZZ999999');

/** The telco says it did not go through. */
export const CREDIT_FAILED = CREDIT_100_37.replace('>Completed<', '>Failed<');

/**
 * The receiver row is gone — a plausible markup drift. Must be indeterminate,
 * never verified: a receipt whose destination we cannot read is not evidence
 * that the destination was us.
 */
export const CREDIT_NO_RECEIVER = CREDIT_100_37.replace(
  '<tr><td>Credited party account no</td><td>251911***426</td></tr>',
  '',
).replace('<tr><td>Credited Party name</td><td>DAWIT G</td></tr>', '');

/**
 * The balance-first trap, ported from the SMS fixture `BANKS.balanceFirst`.
 * The balance figure must not end up in `amountsMinor`.
 */
export const CREDIT_BALANCE_FIRST = `<!DOCTYPE html><html><body>
<table>
  <tr><td>Your balance is ETB 9,999.00 as of today</td></tr>
  <tr><td>Payer Name</td><td>ABEBE K TESFAYE</td></tr>
  <tr><td>Payer telebirr no.</td><td>251912***789</td></tr>
  <tr><td>Credited Party name</td><td>DAWIT G</td></tr>
  <tr><td>Credited party account no</td><td>251911***426</td></tr>
  <tr><td>Transaction status</td><td>Completed</td></tr>
  <tr><td>transaction number is</td><td>CBE7XK2M91</td></tr>
  <tr><td>total Paid Amount</td><td>ETB 100.37</td></tr>
</table></body></html>`;

/** Response cut off mid-table, as a flaky connection would deliver it. */
export const TRUNCATED = CREDIT_100_37.slice(0, 180);

/** A real page, but not a receipt — a portal landing page or an error shell. */
export const UNRELATED_PAGE = `<!DOCTYPE html><html><body>
<h1>Ethio Telecom</h1>
<p>Welcome to our self service portal. Please log in to continue to your account
dashboard where you can view your services, pay your bill and manage your plan.
For assistance please contact customer care on 994 at any time of the day.</p>
</body></html>`;
