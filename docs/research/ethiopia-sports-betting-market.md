# Ethiopia Sports Betting Market: Operators, Product and Payments

_Research snapshot: 7 October 2026. Sources are listed at the end. Most operator data comes from affiliate or review sites, so treat any figure marked "reported" as unverified until it is checked against an operator's own cashier or an official notice._

---

## 1. Executive summary

1. **No sports betting operator holds a licence in Ethiopia today.** The Ethiopian Lottery Service (ELS, formerly the National Lottery Administration, NLA) suspended 22 operators on 4 Dec 2025. It then revoked **every** sports betting licence with effect from 15 Dec 2025. Banks and payment providers were ordered to block betting transactions. ELS repeated in July 2026 that no licensed operator exists.
2. **Vamos is directly affected.** "Vamos Entertainment PLC" is on the published list of the 22 suspended firms.
3. **A relaunch is being prepared, but no date is set.** ELS is building a **unified, real-time digital monitoring system**, and operators reportedly must connect to it before new licences are granted. Expect stricter rules on revenue reporting, payments and KYC than before.
4. **Before the ban the market was large and ran on mobile money.** A draft audit found about **Birr 199 bn** in transactions between July 2023 and Dec 2025. Deposits and withdrawals ran almost entirely on **telebirr, CBE Birr and M-Pesa**, often through payment gateways (Chapa, ArifPay, SantimPay, Kacha). One analysis says betting was over 99% of payment-gateway volume in 2025.
5. **Payment rails are now the main enforcement point.** Gateway accounts were reportedly frozen and their executives detained. Any future product has to treat payments compliance (transaction reporting, tax withholding, KYC with Fayda ID) as a core feature from the start, not an add-on.

**Implication for this project:** build for the **relaunch licence regime**, not the old one. Do not take real-money bets or route payments until a licence under the new framework is issued.

---

## 2. Regulatory timeline

| Date | Event |
|---|---|
| 2009 | NLA Re-establishment Council of Ministers Regulation allows "sports-betting lotteries". |
| 2021 | Sports-Betting Lottery Directive No. 172/2021 sets detailed rules. Legal betting age is reported as 21+ (older sources say 18+). |
| Pre-2025 | Reported licence fee ETB 500,000, renewal ETB 100,000. Reported 15% commission on revenue to the NLA, plus a 15% levy on winnings. |
| 2025 | Proclamation 1395/2025 reportedly raises the tax on winnings from about 15% to **20–25%** of the prize. |
| Nov–Dec 2025 | NISS alleges more than ETB 100 bn of revenue was concealed and moved abroad through crypto and hawala. Arrests are made. |
| 4 Dec 2025 | ELS suspends 22 operators (list in §3.1). |
| 15 Dec 2025 | ELS revokes **all** sports betting licences. Online, retail, agents and the related payment services must stop. Banks and payment providers must block betting transactions. Operators must keep their financial, server and customer records. |
| Jan 2026 | The 24 detainees are released. No public word on whether charges continue. |
| Feb 2026 | Parliament hearing. State minister says a permanent ban is "impossible". Two ministries overseeing the sector is named as a weakness. |
| Mid-2026 | Federal High Court rules the suspension of **Hulu Sport** unlawful on procedural grounds. ELS appeals and gets a stay. The licence is **not** restored. |
| Jul 2026 | ELS public notice: no licensed operator exists. It warns the public against depositing with illegal platforms. |
| Aug 2026 | Enforcement widens to 38 betting businesses (tax evasion, illicit flows). This comes from a single source. |
| Sep 2026 | Audit published. Operators owed about **Birr 30 bn** in commissions and paid about **Birr 3.6 bn**, leaving roughly **Birr 27.5 bn** unpaid. Dash Betting alone owes about Birr 8.64 bn. ELS announces a "strict relaunch" with digital monitoring. |
| Sep 2026 | About **Birr 20 bn** was reportedly transacted through **unlicensed** platforms in that month alone (FMC investigation cited by Fana). |

### What the relaunch is likely to require (inferred from reporting, not yet published)

- A real-time transaction feed to the ELS monitoring platform, so ELS can compare actual activity with the commissions and fees owed.
- Proof that all financial obligations can be monitored **throughout** operations, not only checked at licensing.
- Payment providers acting as gatekeepers that allow only licensed operators.
- Commission and winnings tax withheld and remitted automatically.
- Most likely, Fayda national ID KYC. Fayda is already mandatory for new bank accounts from Jan 2026.

No technical specification (data formats, APIs, reporting schedule) has been published yet.

---

## 3. Operator landscape

### 3.1 Local operators (all suspended or revoked)

The 22 firms suspended on 4 Dec 2025, as listed by Birr Metrics (spellings vary between outlets):

Dash Bet · Exnet Solution · Black Pearl Trading · Jambo Bet · ETEL (KWIK) · **Vamos Entertainment** · Hulegeb Online Solution · Hulu Gaming · Unique Sports Betting · Kukulu Sport · Walia Sport · HDM/Afro Trading · iKinetic Sport Entertainment · Daabaaak Trading · Beta Arada Sport & Entertainment · Super Flash Sport · Zemen Sports Betting · Addis Telco Service (Betika's local entity) · Betika Sport Lottery · Toto Sport Solution · Merke Betting · Champion Harif Sport

Brands that featured most in market reviews before the ban:

| Brand | Positioning / notable features (reported) | Payments (reported) |
|---|---|---|
| **Hulusport** | Long-time market leader. Won a court ruling in 2026 that was stayed on appeal. | Mobile money (details not documented) |
| **Betika** (via Addis Telco) | Pan-East African brand. Large daily and weekly jackpots, cash-out, SMS/USSD betting, "lite" site, Android/iOS apps. 100% welcome bonus up to ETB 5,000. | Telebirr, CBE Birr |
| **Vamos** | Multi-bet boost on slips with 7+ selections, free-bet bonus, casino and app | Mobile money (telebirr, M-Pesa reported) |
| **Dash Bet** | Large volume (biggest single debtor in the audit) | Telebirr, M-Pesa. Reported limits: ETB 10 min, ETB 50,000 max |
| **Winner Ethiopia** | English and **Amharic** UI, acca boosts, bet builder, live streaming, cash-out, weekly jackpot (up to ETB 1 m), Aviator promos, "second chance" | Telebirr, CBE Birr, Amole, HelloCash, bank transfer |
| **Telebet** | Low minimum stake. Free-bet winnings must be wagered before withdrawal. | Telebirr, AddisPay + Telebirr, CBE Birr. Reported limits: ETB 5 min, ETB 75,000 max |
| **EthioBet** | Sports, casino, APK download | Telebirr, HelloCash, CBE Birr, M-Birr, bank. Reported ETB 50 minimum. Mobile money payouts "within hours". |
| **Habesha Bet**, **Abyssiniabet**, **Kukulu**, **Walia**, **Jambo** | Jackpots (Abyssiniabet: up to ETB 1 m), multibonus offers | Mobile money |

### 3.2 International / offshore operators

These sites accept ETB and local wallets but hold **offshore** (for example Curaçao) licences, not Ethiopian ones. Under the current ELS position they are illegal for Ethiopian residents. They matter as competitors and as a benchmark for product features.

| Brand | Reported features | Payments (reported) |
|---|---|---|
| **1xBet** | Very large markets catalogue, ETB accounts, many e-wallets and crypto | Deposit: Telebirr, SantimPay. Withdraw: Telebirr, M-Pesa, CBE Birr. Min deposit ETB 20–85 depending on source. Payouts in about 15 min (operator claim). |
| **Melbet** | Amharic UI, ETB accounts, 50+ payment methods including crypto, 200% welcome bonus | Telebirr, CBE Birr. Casino min deposit ETB 25. |
| **22Bet** | Large catalogue | Min deposit ETB 130, min withdrawal ETB 200, payouts in 1–3 days |

**Key observation:** the ban did not remove demand. It moved activity to offshore and Telegram-promoted sites, scams that pose as "reopened" operators, and agent or hawala networks. ELS uses its official Telegram channel to warn users. A licensed operator after relaunch will compete with these channels on **trust and payout speed**.

---

## 4. Product patterns that worked in Ethiopia

What the pre-ban leaders had in common:

1. **Low stakes.** Minimum bets around ETB 5–10. Retail shops took bets from ETB 10.
2. **Football first.** Mainly EPL, plus La Liga, Serie A, UCL and the Ethiopian Premier League. Accumulators (multi-bets) dominate.
3. **Multi-bet boosts.** A percentage bonus that grows with the number of selections (Vamos: 7+ legs).
4. **Jackpots.** Pick-13 or pick-17 style weekly and daily jackpots with ETB 0.5–1 m top prizes.
5. **Crash and instant games.** Aviator-style games and casino as add-ons.
6. **Cash-out and live betting.** Offered by the leading brands. Live streaming is rarer.
7. **Low-bandwidth access.** Lite sites, small APKs (installed outside app stores), SMS/USSD betting (Betika), and Telegram channels for odds and promotions.
8. **Local language.** Amharic UI (Winner, Melbet). Afaan Oromo and Tigrinya are an open gap.
9. **Retail network.** Thousands of shops existed. Addis Ababa closed 3,241 to over 4,000 of them in an earlier city crackdown. Shops drove cash deposits and youth access, which was a key regulatory concern.

**Risk areas regulators focused on:** minors (reports of under-18 customers), addiction and youth financial harm, under-reported revenue, illicit outflows (crypto and hawala), and unlicensed operators working alongside licensed ones.

---

## 5. Deposits and withdrawals

### 5.1 Payment rails

| Rail | Type | Scale (reported) | Notes |
|---|---|---|---|
| **telebirr** (Ethio Telecom) | Mobile wallet, USSD `*127#` + app/SuperApp | ~54.8 m users (FY 2024/25, vendor figure) | The main betting rail. Merchant APIs through developer.ethiotelecom.et (Fabric token → create order → `receiveCode` → server `notify_url` / `queryOrder`). |
| **CBE Birr** (Commercial Bank of Ethiopia) | Bank-backed wallet | Large | Supported by almost every operator |
| **M-Pesa** (Safaricom Ethiopia) | Mobile wallet | 5.2 m active (FY to Mar 2026), 442 m transactions | Supported by some operators (Dash, 1xBet withdrawals) |
| HelloCash, Amole, M-Birr, E-Birr, Kacha | Wallets | Smaller | Some operators |
| Bank transfer | Bank | — | Slower, used for large amounts |
| **Payment gateways**: Chapa, ArifPay, SantimPay, Kacha, AddisPay | NBE-licensed Payment Gateway Operators that aggregate the wallets above | Betting was reportedly >99% of gateway volume in 2025 | Reported fees 2–3%. **Accounts were reportedly frozen and executives detained in the crackdown.** |

### 5.2 Typical deposit flow (pre-ban)

1. The user logs in (phone number + password/OTP) and opens **Deposit**.
2. The user picks a wallet (telebirr / CBE Birr / M-Pesa) and enters the amount (min ETB 5–50).
3. One of three ways to pay:
   - **Push / in-app checkout (most common):** the operator's backend creates an order through the gateway or wallet API. The user approves in the wallet app or a USSD prompt by entering their **PIN**. The wallet calls the operator's webhook and the balance is credited **instantly**.
   - **Redirect checkout (web):** a hosted gateway page (Chapa or ArifPay style) where the user picks a wallet and confirms.
   - **Manual USSD merchant pay:** the user dials `*127#` → Pay merchant → enters the **merchant short code** + amount + PIN, then gets an SMS receipt from 127. Some sites asked users to paste the transaction ID so they could reconcile it.
4. Wallet funding itself: depositing cash into telebirr at an agent is free.

### 5.3 Typical withdrawal flow (pre-ban)

1. The user opens **Withdraw** and enters an amount. Reported minimums range from ETB 20 to 200, and maximums per transaction from ETB 50,000 to 75,000.
2. Payouts usually go **only to the wallet or phone number registered on the account**. This is the main control against fraud and money laundering.
3. The operator checks: KYC status (national ID upload before the first withdrawal), bonus wagering conditions (for example free-bet winnings must be wagered first), and AML/velocity rules.
4. **Withholding tax** on winnings is deducted at source (15% historically, reportedly 20–25% after Proclamation 1395/2025, with a small-win exemption under ETB 100 under the old rules).
5. Payout goes out as B2C or disbursement through the gateway or wallet API. The user gets an SMS.
6. Reported times range from **about 15 minutes to 24 hours** for mobile money and **1–3 days** for offshore or bank transfers. Fast, reliable withdrawals were the main trust factor in reviews.
7. To cash out, the user withdraws from telebirr at an agent or shop using an agent ID, voucher or QR, from the app or `*127#`. Telebirr cash-out fees (2022 tariff) start at ETB 1 for ETB 51–100 and rise to ETB 23 for amounts above ETB 35,000.

### 5.4 Payment lessons for a compliant product

- **Assume every betting payment must be traceable by ELS in real time.** Build a ledger in which each stake, win, deposit, withdrawal, commission and tax line can be reported automatically.
- **Use only NBE-licensed rails** that ELS has approved for the relaunch. Expect payment providers to whitelist licensed operators.
- **Bind the payout destination to the KYC'd identity.** Allow payouts only to a wallet or account in the verified person's name. Integrate Fayda ID verification.
- **Withhold and remit winnings tax automatically** at the configured rate. Make the rate a configuration value because it has changed recently.
- **No crypto and no informal agents.** These were the stated channels for illicit outflows.
- **Show payout status transparently** (pending → approved → paid) with SMS notifications, so users have a reason to trust a licensed operator over offshore sites.
- **Responsible gambling built in:** age gate (21+ reported), deposit and loss limits, self-exclusion, cooling-off periods. Under-18 betting was a central reason for the crackdown.

---

## 6. Recommendations for the Vamos project

1. **Do not operate real-money betting** or connect live payment rails until a licence under the new ELS framework is granted. Vamos Entertainment's earlier licence was suspended, and later every licence was revoked.
2. **Build a platform ready for the relaunch.** Prioritise:
   - a double-entry wallet/ledger with an immutable audit trail;
   - a regulator reporting adapter (pluggable, since the ELS spec is not yet published);
   - a payments abstraction layer (telebirr direct, CBE Birr, M-Pesa, licensed gateway) behind feature flags;
   - KYC (Fayda) + AML rules + payout-to-own-account enforcement;
   - a tax engine for commission and winnings tax.
3. **Keep the product strengths of the leading local brands:** low minimum stakes, football accumulators with multi-bet boosts, jackpots, cash-out, a fast lite web app with low data use, and Amharic plus other local languages.
4. **Watch for:** the published relaunch regulation and monitoring-system spec, the outcome of the Hulu Sport appeal, and the status of the gateway account freezes (Chapa, ArifPay, SantimPay, Kacha).
5. **Verify** every figure in this document marked "reported" before relying on it commercially. Get legal advice from Ethiopian counsel before going live.

---

## Sources

**Regulation and enforcement**
- [SiGMA – Ethiopia revokes all sports betting licences](https://sigma.world/news/ethiopia-revokes-all-sports-betting-licences/)
- [Addis Insight – Ethiopia revokes licenses of all sports betting companies](https://addisinsight.net/2025/12/15/ethiopia-revokes-licenses-of-all-sports-betting-companies/)
- [Addis Insight – 22 agencies suspended](https://addisinsight.net/2025/12/04/ethiopia-suspends-licenses-of-22-sports-betting-agencies-amid-massive-embezzlement-probe/)
- [Birr Metrics – Regulator revokes 22 betting licences (list of firms)](https://birrmetrics.com/regulator-revokes-22-betting-licences-after-probe-finds-100-bln-birr-mismanagement/)
- [Birr Metrics – Relaunch signalled after Br27.5B audit](https://birrmetrics.com/sports-betting-relaunch-ethiopia-audit/)
- [Capital Ethiopia – Strict relaunch for sports betting, digital lotteries (Sep 2026)](https://capitalethiopia.com/2026/09/20/ethiopia-prepares-strict-relaunch-for-sports-betting-digital-lotteries/)
- [Ethio Negari – Relaunch under new rules](https://ethionegari.com/2026/09/20/ethiopia-to-relaunch-sports-betting-under-new-rules/)
- [iGaming Afrika – ELS set to revive sports betting](https://igamingafrika.com/els-set-to-revive-sports-betting-and-digital-lottery-services-in-ethiopia/)
- [iGaming Business – Ban reaffirmed, scammers exploit vacuum](https://igamingbusiness.com/legal-compliance/ethiopia-betting-ban-regulatory-uncertainty/)
- [SiGMA – Appeal blocks Hulu Sport comeback](https://sigma.world/news/ethiopia-appeal-blocks-hulu-sport-comeback/)
- [EEGaming – 38 betting firms targeted (Sep 2026)](https://eegaming.org/latest-news/2026/09/02/52419/ethiopia-targets-38-betting-firms-in-crackdown-on-tax-evasion-and-illegal-financial-activities)
- [Tribuna – 22 firms incl. Betika suspended](https://tribuna.com/en/casino/news/2026-01-06-ethiopia-suspends-22-sports-betting-firms-including-betika-over-alleged-hidden-revenue-of/)
- [Shega – Ethiopia shuts down entire betting industry](https://www.shega.co/news/ethiopia-shuts-down-entire-betting-industry-revokes-all-licenses)
- [Shega Weekly – Regulatory dice roll](https://shegaweekly.substack.com/p/issue-257-regulatory-dice-roll)
- [Slotegrator – Online gambling in Ethiopia: laws 2026](https://slotegrator.pro/analytical_articles/online-gambling-in-ethiopia/)
- [GamblingMaps – Ethiopia rules for operators](https://gamblingmaps.org/map/regulations/ethiopia/for-operators)
- [SiGMA – Ethiopia increases gambling taxes](https://sigma.world/news/ethiopia-increases-gambling-taxes-to-generate-state-revenue/)
- [Abyssinia Law – Legality of sport betting in Ethiopia](https://www.abyssinialaw.com/blog/the-legality-of-sport-betting-in-ethiopia?tmpl=component&print=1&format=print)

**Operators and product (mostly affiliate or review sites, unverified)**
- [Tribuna – Ethiopia bookmakers](https://tribuna.com/en/betting/betting-sites/ethiopia-bookmakers/)
- [BCA – Betting sites in Ethiopia](https://bettingcompanies.africa/ethiopia/)
- [BCA – Winner Ethiopia review](https://bettingcompanies.africa/review/winner-ethiopia/)
- [Bet.et – List of Ethiopia betting sites](https://bet.et/list-of-ethiopia-betting-sites/)
- [allaboutETHIO – 12 top Ethiopian betting sites](https://allaboutethio.com/12-top-ethiopian-betting-sites-for-sports-betika-hulu-sport.html)
- [Ghanasoccernet – Hulusport bonuses](https://ghanasoccernet.com/en-et/bonusy-bukmeker/hulusport-ethiopia/)
- [Capital Ethiopia – Top multi-bet bonuses (2024)](https://capitalethiopia.com/2024/02/14/top-multi-bet-bonuses-for-ethiopian-punters/)
- [Capital Ethiopia – Melbet overview](https://capitalethiopia.com/2024/10/02/melbet-website-overview-in-ethiopia/)
- [RatingBet – Ethiopia bookmakers](https://ratingbet.com/en-et/bookmakers/)
- [Takebet – Betika review](https://takebet.com/betting-sites/review/betika)

**Payments**
- [Dash Bet – Deposit & withdrawal](https://dashbets.net/payment-withdrawal)
- [MightyTips – Dashbet Ethiopia review](https://www.mightytips.com/bookmakers/dashbet-ethiopia/)
- [Ethiopiabetting – Telebet](https://ethiopiabetting.com/telebet/)
- [Paris-sportifs-africa – EthioBet](https://paris-sportifs-africa.net/en/ethiobet/)
- [Ethiopia-1xbet – 1xBet in Ethiopia](https://ethiopia-1xbet.org/)
- [Ethiopiabettingsites – Betting with CBE Birr](https://ethiopiabettingsites.com/betting-in-ethiopia-with-cbe-birr/)
- [SlotCatalog – Telebirr casinos](https://slotcatalog.com/en/telebirr) · [CBE Birr casinos](https://slotcatalog.com/en/cbe-birr)
- [Ethio Telecom – telebirr withdraw cash](https://www.ethiotelecom.et/telebirr/withdraw/) · [Pay with telebirr](https://www.ethiotelecom.et/telebirr/utility-bill-payment-telebirr/) · [Deposit cash](https://www.ethiotelecom.et/telebirr/deposit/)
- [Shega – telebirr tariffs](https://shega.co/news/telebirr-tariffs-telebirr-pricing)
- [pub.dev – telebirr in-app purchase SDK (integration flow)](https://pub.dev/packages/telebirr_inapp_purchase_plus/versions/1.0.2)
- [Chapa WooCommerce plugin](https://github.com/Chapa-Et/chapa-woocommerce) · [ArifPay developers](https://arifpay.net/Developers)
- [A-Pay – Payment gateway in Ethiopia](https://a-pay.one/country/ethiopia)
- [EdgeX – Crackdown on fintech payment gateways](https://pro.edgex.exchange/en-US/news/article/ethiopia-crackdown-fintech-payment-gateways)
- [Ecofin – M-Pesa Ethiopia reaches 5.2 m subscribers](https://www.ecofinagency.com/news-digital/0805-55402-m-pesa-ethiopia-subscriber-base-jumps-120-to-5-2-million)
- [The Reporter – Betting firms' bank accounts frozen](https://www.thereporterethiopia.com/27678/)
- [Didit – KYC/AML in Ethiopia (Fayda)](https://didit.me/solutions/countries/ethiopia/)

**Market and social impact**
- [Shega – Addis Ababa betting shop crackdown](https://shega.co/news/addis-ababas-crackdown-on-betting-shops-sparks-public-support-confusion)
- [Capital Ethiopia – Betting drawing minors (2019)](https://capitalethiopia.com/2019/03/11/risky-business-sports-betting-drawing-minors-fostering-addiction/)
- [AAU thesis – Legal and institutional framework for sports betting](https://etd.aau.edu.et/items/356003d1-f083-40c3-a0db-3d7a1312a775/full)
