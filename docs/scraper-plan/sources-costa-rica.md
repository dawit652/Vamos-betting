# Costa Rica: data sources, recommendation and ratings history

|                  |                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Status           | Research and recommendation for a person to decide. **Not legal advice; legal sign-off on each source's terms stays with a person.** |
| Researched on    | 2026-10-29                                                                                                                           |
| Part of          | [plan 07](07-sources-ratings-and-shadow-mode.md), [feed new source runbook](../runbooks/feed-new-source.md)                          |
| Files this made  | `data/costa-rica-teams.csv`, `data/source-api-football.json`, `data/source-unafut.json` (drafts, loaded nowhere)                     |
| **Not produced** | `data/costa-rica-history.json` (see section 6: it could not be transcribed and validated, so nothing was committed)                  |

## 0. Read this first: how far this research could be verified

The sandbox's page fetcher was refused by the network policy for the first two hosts tried (`en.wikipedia.org`
and `www.unafut.com`: "outside the session's allowed network domains"), and its own guidance was to stop trying
other sites. Everything below therefore comes from **web search results (summaries written by the search tool, with
their links)**, read on 2026-10-29. What that means:

- **No `robots.txt` was read for any host.** Nothing in this document says what any robots file allows.
- **No terms-of-use page was read in full.** The clauses quoted in the appendix are what the search tool printed
  as quotations from those pages; they are second-hand and must be checked against the live page.
- No page markup or JSON response was inspected. Selectors and response paths in the draft files are placeholders
  or written from memory of a vendor's documented shape (marked in section 7).
- Match results could not be fetched, so the ratings history could not be transcribed or reconciled.
- Search summaries sometimes contradicted each other (notably the club list, section 2); the doubt is marked
  where it matters.

To finish the job, an administrator can allow these hosts for the session and the work can be repeated in about an
hour: `es.wikipedia.org`, `en.wikipedia.org`, `www.unafut.com`, `www.fedefutbol.com`, `www.teletica.com`,
`crhoy.com`, `www.nacion.com`, `www.api-football.com`, `api-sports.io`, `www.sportmonks.com`,
`docs.sportmonks.com`, `www.thesportsdb.com`, `football-data.org`.

## 1. Decision summary

- **First competition: the Costa Rican top division, "Liga de Fútbol de Primera División" (Liga FPD), sponsored
  name Liga Promerica**, run by UNAFUT. Ten clubs. Two tournaments a year (Apertura, Clausura), each 18 matchdays
  (90 matches), then a top-four play-off. **Play-off ties are two-legged and a tied aggregate goes to extra time
  and then penalties** (no away-goals rule), so the competition needs the `extraTime` handling from the
  semifinals onward; the regular season never has extra time. Current tournament: Apertura 2026, started 23 July
  2026, regular season until about 6 December, play-offs 9 to 26 December 2026.
- **Recommended pair for shadow mode (different upstreams):**
  1. **API-Football (API-Sports), Pro plan, 19 USD a month**, as the licensed independent feed. Conditional on
     three things nobody has checked yet: that it really covers the league with half-time scores for the current
     season; that its licence allows a betting operator (its terms say betting use "may require additional
     licenses from the relevant rights holders", so ask in writing); and a small code change, because the existing
     JSON adapter cannot send the API key header.
  2. **The UNAFUT official site** (`www.unafut.com`), as the official primary, read with the HTML adapter. Its
     upstream is UNAFUT's own data, produced by Genius Sports' LiveStats under a 2020 agreement. Conditional on a
     person reading its terms and `robots.txt`, and on an engineer finding the selectors.
- **Fallback:** Sportmonks (Starter, 29 EUR a month, any 5 leagues) if it covers the league; failing that a
  quote from Sportradar, Stats Perform or Genius Sports. If neither pair member works, run with a single upstream
  and let traders apply results by hand (rule R6, `result_unverified`); the engine never applies a single-source
  result by itself.
- **Not recommended:** Costa Rican news sites (their terms restrict reuse and they are not structured data),
  TheSportsDB (volunteer data), football-data.org (no evidence it covers the league), and any score aggregator.
  Wikipedia is for the ratings history only (CC BY-SA 4.0), never a live source.
- **Honest limit on "go live".** Shadow mode needs 200 results compared with ground truth. From now to the
  Apertura final there are only about 30 matches left (25 regular-season matches plus the play-offs), so the
  scorecard cannot be met before the Clausura 2027 regular season. Plan for traders confirming results by hand
  (`result_ready`) until then.
- **Ratings history: not done** (section 6). The two complete tournaments are Apertura 2025 and Clausura 2026,
  about 180 regular-season matches. The pages to use, the format, and the validation procedure are written down
  and the numbers to reconcile against are partly known, but no file was committed because it could not be
  reconciled.

## 2. The competition

| Question                      | Finding                                                                                                                                                                                                                                                                                                                                                                | Source                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Official name                 | Liga de Fútbol de Primera División, "Liga FPD"; sponsor name **Liga Promerica** (2025-26 and 2026-27)                                                                                                                                                                                                                                                                  | [en.wikipedia 2025-26 Liga FPD](https://en.wikipedia.org/wiki/2025%E2%80%9326_Liga_FPD), [UNAFUT](https://www.unafut.com/en/2026/06/09/definido-el-camino-a-la-gloria-unafut-presenta-el-calendario-del-apertura-2026)                                                                                                                                           |
| Organiser                     | UNAFUT (Unión de Clubes de Fútbol de la Primera División); the national federation is Fedefútbol                                                                                                                                                                                                                                                                       | [UNAFUT about page](https://www.unafut.com/acerca-unafut/)                                                                                                                                                                                                                                                                                                       |
| Season shape                  | Season 2025-26 = Apertura 2025 + Clausura 2026; season 2026-27 = Apertura 2026 + Clausura 2027                                                                                                                                                                                                                                                                         | [en.wikipedia](https://en.wikipedia.org/wiki/2025%E2%80%9326_Liga_FPD)                                                                                                                                                                                                                                                                                           |
| Teams                         | **10** (down from 12 after Guanacasteca and Santos de Guápiles lost their licences). Kept at 10 for 2026-27 after a legal analysis; an enlargement from 2027-28 is only being discussed                                                                                                                                                                                | [La Nación](https://www.nacion.com/puro-deporte/futbol/unafut-ya-definio-esta-es-la-cantidad-de-equipos/GH7NIK72UBH53A5QBGH3QSBVF4/story/), [Teletica](https://www.teletica.com/amp/nacional/con-10-equipos-asi-se-jugara-el-proximo-torneo_387514) (search summaries; second-hand)                                                                              |
| Clubs in Apertura 2026        | Alajuelense, Saprissa, Herediano, Cartaginés, Pérez Zeledón, Puntarenas, Sporting, San Carlos, Inter San Carlos, Escorpiones. **Doubt:** one search result still listed Municipal Liberia and said Liberia lost its licence; the Guadalupe/Liberia/Escorpiones changes could not be confirmed. A person must check the club list on UNAFUT before the teams are seeded | [es.wikipedia Apertura 2026](<https://es.wikipedia.org/wiki/Campeonato_de_Apertura_2026_(Costa_Rica)>), [Fútbol Centroamérica jornada 1](https://futbolcentroamerica.com/costarica/apertura-2026-partidos-horarios-y-donde-ver-en-vivo-la-jornada-1-de-la-liga-promerica)                                                                                        |
| Regular season                | Each tournament: 18 matchdays, double round robin, 90 matches                                                                                                                                                                                                                                                                                                          | [UNAFUT calendar news](https://www.unafut.com/en/2026/06/09/definido-el-camino-a-la-gloria-unafut-presenta-el-calendario-del-apertura-2026), [Futbol Centro America](https://futbolcentroamerica.com/costarica/unafut-presento-el-calendario-del-apertura-2026-cuando-empieza-la-liga-promerica-y-en-que-fecha-juegan-saprissa-vs-alajuelense)                   |
| Play-offs                     | Top four: semifinals 1 v 4 and 2 v 3, two legs; then a two-legged final. A "Gran Final" (two legs) is played when the winner of the play-off is not the regular-season leader; if the leader wins the play-off it is champion with no Gran Final (Clausura 2026)                                                                                                       | [Futbol Centro America](https://futbolcentroamerica.com/costarica/herediano-vs-saprissa-como-se-define-la-final-si-empatan-en-el-global), [en.wikipedia](https://en.wikipedia.org/wiki/2025%E2%80%9326_Liga_FPD)                                                                                                                                                 |
| **Extra time / penalties**    | **Yes, in the play-offs only.** A two-legged series level on aggregate after the second leg goes to two extra-time periods of 15 minutes, then penalties. No away-goals rule. Reported as article 95 of the 2025-26 competition rules. Single-leg cups differ (the 2026 Recopa went straight to penalties). The regular season has no extra time                       | [Futbol Centro America](https://futbolcentroamerica.com/costarica/herediano-vs-saprissa-como-se-define-la-final-si-empatan-en-el-global), [Teletica](https://www.teletica.com/municipal-liberia/gol-de-visita-es-criterio-de-desempate-en-una-semifinal-esto-dice-el-reglamento_398699). The rulebook itself was not read                                        |
| Apertura 2026 dates           | Calendar published 2026-06-09. Matchday 1: 23 to 26 July 2026. Semifinal legs 9 and 10 December, then 12 and 13 December. Final 16 and 20 December. Gran Final, if needed, 23 and 26 December. Matchday 14 weekend of 30 October to 1 November (second Clásico on 1 November)                                                                                          | [UNAFUT](https://www.unafut.com/en/2026/06/09/definido-el-camino-a-la-gloria-unafut-presenta-el-calendario-del-apertura-2026), [Futbol Centro America](https://futbolcentroamerica.com/costarica/unafut-presento-el-calendario-del-apertura-2026-cuando-empieza-la-liga-promerica-y-en-que-fecha-juegan-saprissa-vs-alajuelense). Clausura 2027 dates: not found |
| Last two complete tournaments | **Apertura 2025** (24 July to 20 December 2025; champion Alajuelense, final legs 2-2 and then Alajuelense 3-1 Saprissa, 5-3 on aggregate). **Clausura 2026** (to May 2026; champion Herediano, final legs Saprissa 2-1 Herediano and Herediano 2-0 Saprissa, 3-2 on aggregate, no extra time needed)                                                                   | [es.wikipedia Apertura 2025](<https://es.wikipedia.org/wiki/Campeonato_de_Apertura_2025_(Costa_Rica)>), [La Opinión](https://laopinion.com/2025/12/21/alajuelense-vence-a-saprissa-y-se-corona-campeon-en-costa-rica/), [La República](https://www.larepublica.net/noticia/herediano-remonta-ante-saprissa-y-conquista-el-clausura-2026)                         |
| Time zone                     | `America/Costa_Rica`, UTC-6 all year, no daylight saving (checked against the system time-zone database, not a web source). Kickoffs given as local time need this zone; rule T1 will never meet a DST gap                                                                                                                                                             | system tzdata                                                                                                                                                                                                                                                                                                                                                    |

Consequences for our rules:

- **`extraTime` flag.** The flag is per catalogue competition, and the generic adapters cannot split a source's
  rounds into two competitions. Leave `extra_time` off while only regular-season matches are in play; **switch it
  on before the first semifinal (9 December 2026)**, and keep `auto_results` off for the play-offs. With it on, a
  person confirms every result (rule R5).
- **R3.** A source that reports a second-leg score including extra time produces `result_conflict` against a
  source that reports 90 minutes. That is the intended safe outcome. Configure every source with the score basis
  it really gives (`regular_time` only if it is the 90-minute score) and never map extra-time or penalty statuses to
  `finished` (the API-Football draft leaves `AET` and `PEN` unmapped on purpose).
- **Matches left for shadow mode:** Apertura 2026 has about five regular-season matchdays (25 matches)
  and 6 to 8 play-off matches left.

### Catalogue

The seed (`packages/db/src/seed/catalog.ts`) now holds category `costa-rica` (country `CR`, first in the football
list) with the featured competition `primera-division` ("Primera División") and the ten clubs marked
`in_apertura_2026 = yes` in `data/costa-rica-teams.csv`. Ratings are neutral (`attack 1, defence 1`, no `matches`,
no `manual`), so rule O1 treats them as not calibrated until a trader runs `ratings set` or `ratings backfill`.
**Municipal Liberia and Guadalupe were left out**: their place in Apertura 2026 is contradicted across sources
(section 2) and a person has not yet checked the club list on UNAFUT; add them when that is done. The alias draft
`data/costa-rica-aliases.csv` is in the `aliases import` format (team aliases from the evidenced spellings, four
competition aliases, all sources); the one "Liga" variant for Alajuelense was left out because it also names the
league and other clubs. Import it with `aliases import --file docs/scraper-plan/data/costa-rica-aliases.csv`.

## 3. Candidate sources

Every URL below was found by search on 2026-10-29. "Robots" is **not read** for all of them; "terms" give what the
search tool quoted or paraphrased. Verdicts: **use**, **possible** (needs the person's steps) or **do not use**.

| #   | Source                                                            | Provides                                                              | Upstream (who produces it)                                       | Verdict                                                                                       |
| --- | ----------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | UNAFUT, `www.unafut.com`                                          | Fixtures, results, per-club calendars                                 | UNAFUT; match data from Genius Sports LiveStats (2020 agreement) | **Possible**: best free primary, blocked on terms and selectors                               |
| 2   | Fedefútbol, `www.fedefutbol.com`                                  | Federation news and competition rules; league results not confirmed   | Fedefútbol / UNAFUT                                              | **Do not use** for results (not checked; league data comes from UNAFUT); use for the rulebook |
| 3   | Teletica, `www.teletica.com`                                      | News, previews, results articles                                      | Own reporters plus UNAFUT data (unverified)                      | **Do not use**                                                                                |
| 4   | CRHoy, `crhoy.com`                                                | News, results articles                                                | Own reporters plus UNAFUT data (unverified)                      | **Do not use**                                                                                |
| 5   | La Nación, `www.nacion.com`                                       | News, results articles                                                | Own reporters plus UNAFUT data (unverified)                      | **Do not use**                                                                                |
| 6   | Fútbol Centroamérica, `futbolcentroamerica.com`                   | Previews, match reports, calendars                                    | Own writers (unverified)                                         | **Do not use** (terms not found; not structured)                                              |
| 7   | Wikipedia (es, en)                                                | Season articles with full result grids and tables                     | Volunteers copying UNAFUT and media                              | **Use for the ratings history only**; do not use live                                         |
| 8   | API-Football (API-Sports)                                         | Fixtures, results, half-time, extra-time and penalty scores, ids      | API-Sports' own collection (not stated; ask)                     | **Possible**: leading licensed candidate                                                      |
| 9   | Sportmonks                                                        | Fixtures, scores, livescores, odds                                    | Sportmonks' own collection (not stated)                          | **Possible** as fallback; coverage and adapter fit unverified                                 |
| 10  | football-data.org                                                 | Fixtures and results for a fixed list of leagues                      | Own collection                                                   | **Do not use**: no sign it lists Costa Rica                                                   |
| 11  | TheSportsDB                                                       | Crowd-sourced event database                                          | Volunteers                                                       | **Do not use** for settlement                                                                 |
| 12  | Sportradar                                                        | Enterprise sports data, betting-grade                                 | Own scouts and official feeds                                    | **Possible** by quote only; league coverage unverified                                        |
| 13  | Stats Perform (Opta)                                              | Enterprise data; holds official rights in some Latin American leagues | Own collection                                                   | **Possible** by quote only; no sign it holds Costa Rica                                       |
| 14  | Genius Sports                                                     | Official data and integrity partner of UNAFUT since 2020              | Its own LiveStats collectors at every UNAFUT match               | **Possible** by quote; if bought it is the same upstream as source 1 (one vote)               |
| 15  | Score aggregators (Soccerway, ESPN, Sofascore, Eurosport, others) | Tables, results                                                       | Unknown; usually licensed feeds                                  | **Do not use** (not assessed; their terms were not read)                                      |

### 3.1 UNAFUT official site

- **URL and form.** `https://www.unafut.com/`. HTML, apparently a WordPress-style site. Seen: per-club calendar
  pages with date, score, stadium and matchday (`https://www.unafut.com/team/municipal-liberia/calendario/`), club
  pages with numeric ids (`https://www.unafut.com/en/club/14050/puntarenas-fc`; ids 14049 Sporting, 14050
  Puntarenas, 14057 Cartaginés, 14078 Herediano, 14103 Pérez Zeledón, 15374 Inter San Carlos), category and tag
  pages (`/category/liga-promerica/`, `/tag/jornada-15/`), and a results page for an earlier season. Whether any
  page lists the whole league's fixtures and results, whether a JSON endpoint exists behind the Genius widgets,
  and the time zone shown on the page are **not verified**.
- **Half-time scores:** not verified.
- **Upstream.** UNAFUT appointed Genius Sports to run LiveStats pitch-side at every match, feeding its website and
  app ([Genius Sports release, February 2020](https://news.geniussports.com/costa-rican-football-appoints-genius-sports-to-lead-live-data-and-integrity-strategy/)).
  The site footer credits Genius Sports. Whether the agreement still applies is not confirmed.
- **robots.txt:** not read (host blocked in this session).
- **Terms:** no terms-of-use page was found by search; the footer shows a privacy policy link and the line that
  content is the site administrator's responsibility. A person must read the live site and, as the league body, ask
  UNAFUT in writing: [contact page](https://www.unafut.com/contacto/).
- **Verdict: possible.** Official and free, but not usable until terms and robots are read and recorded and an
  engineer has fitted selectors on saved pages.

### 3.2 Fedefútbol

`https://www.fedefutbol.com/`. A search for its terms returned nothing from the site. Not assessed; the 2025-26
competition rules (article 95) are published by or through the federation and should be read there. Verdict:
**do not use for results**; fetch the rulebook by hand.

### 3.3 Costa Rican media

| Site                     | What the terms say (search tool, second-hand)                                                                                                                                          | Link                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Teletica                 | The licence to use the sites is limited and users may not copy, print, publish, distribute, sell or otherwise exploit any portion of the material; no clause on automated access found | [terms](https://www.teletica.com/terminos)                                                                |
| CRHoy                    | Name and logo are registered marks, use needs written authorisation; the general terms of use were not found (the page found is for a paid subscription)                               | [terms](https://crhoy.com/terminos-y-condiciones/), [privacy](https://crhoy.com/politicas-de-privacidad/) |
| La Nación (Grupo Nación) | Footer on its pages: all rights reserved, "any use requires express written authorization"; the subscription contract bars copying and redistribution                                  | [corporate pages](https://www.nacion.com/gnfactory/especiales/gruponacion/privacidad.html)                |

All three publish articles, not structured results, and copy their numbers from the league or their own
reporters, so they would add no independent upstream. **Do not use.** (Reading their `robots.txt` was not possible.)

### 3.4 Wikipedia

- **URLs.** Season articles: [en: 2025-26 Liga FPD](https://en.wikipedia.org/wiki/2025%E2%80%9326_Liga_FPD);
  [es: Apertura 2025](<https://es.wikipedia.org/wiki/Campeonato_de_Apertura_2025_(Costa_Rica)>);
  [es: Apertura 2026](<https://es.wikipedia.org/wiki/Campeonato_de_Apertura_2026_(Costa_Rica)>). The Spanish
  Clausura 2026 page title was not confirmed.
- **Provides.** Standings tables and a full result grid per tournament, play-off results, club lists.
- **Upstream.** Volunteer editors copying from UNAFUT and the media, so it follows, never leads.
- **Licence.** Text is CC BY-SA 4.0 (attribution and share-alike). Wikimedia's API guidelines require a
  descriptive User-Agent with contact, obeying throttling, following content licences when republishing, and the
  robot policy for large-scale automatic reading ([guidelines](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_API_Usage_Guidelines),
  [robot policy](https://wikitech.wikimedia.org/wiki/Robot_policy)). `robots.txt` not read.
- **Verdict: use for the history only**, by hand or by a one-off API read. Not a live source: edits lag and a
  vandalised score is possible.

### 3.5 API-Football (API-Sports)

- **URLs.** Site `https://www.api-football.com/`, [pricing](https://www.api-football.com/pricing),
  [terms](https://www.api-football.com/terms), group terms [api-sports.io](https://api-sports.io/terms). API host
  `v3.football.api-sports.io`.
- **Cost.** Free 0 USD, 100 requests a day; Pro 19 USD a month, 7,500 a day; Ultra 29 USD, 75,000 a day; Mega 39
  USD, 150,000 a day. All plans list all competitions and endpoints; free plans are limited in the seasons they can
  read (so the free key may not return the current season; test it). Prices from the pricing page via the search
  tool.
- **Our load.** The runner polls fixtures every 15 minutes and results every 5 minutes in a match window, with one
  request per run for the draft config, so about 100 to 300 requests a day. **The free plan (100 a day) is not
  enough; Pro is.**
- **Provides (from memory of the v3 documentation, not verified here).** One JSON list under `response`; per
  fixture an integer id, an ISO date with offset (UTC unless a time-zone parameter is sent), a status code (`NS`,
  `FT`, `AET`, `PEN`, `PST`, `CANC`, `ABD`, live codes), team names, `goals`, and a `score` object with
  `halftime`, `fulltime`, `extratime`, `penalty`. League id for Costa Rica's Primera División is believed to be
  162; **neither the id, nor coverage of the current season, nor half-time scores for this league were
  verified.**
- **Upstream.** Not stated by the vendor in anything found. Ask. If it turns out to come from UNAFUT/Genius, it is
  not independent of source 1.
- **Terms (quoted by the search tool).** Betting use "may require additional licenses from the relevant rights
  holders" and the vendor gives no licence to publish the data; reselling to third parties is prohibited; multiple
  accounts to get round free limits are prohibited. See appendix A1.
- **Fit with our adapters.** Authentication is a request header (`x-apisports-key`). The fetcher can send plan-item
  headers and only blocks credential-type ones such as `authorization` and `cookie`, but **neither
  `generic-json` config nor any adapter emits headers**, so this source **needs a small code change** (an
  optional per-request header whose value comes from an environment secret, never from the database).
  Do not put the key in the URL or in a stored config. This research did not change code.
- **Verdict: possible**, as the licensed feed, after the steps in section 5.

### 3.6 Sportmonks

- **URLs.** [pricing](https://www.sportmonks.com/football-api/plans-pricing/),
  [terms](https://www.sportmonks.com/terms-of-service/),
  [data use](https://docs.sportmonks.com/v3/welcome/what-can-you-do-with-sportmonks-data),
  [integrity and data-use page](https://www.sportmonks.com/integrity-support/).
- **Cost (search tool).** Starter 29 EUR a month (any 5 leagues, 14-day trial), Growth 99 EUR (30 leagues), Pro
  249 EUR; cheaper yearly. Costa Rica appears in a third-party listing of the enterprise plan, but nothing
  confirmed Liga Promerica on the cheaper plans.
- **Terms (search tool).** Storing and distributing data inside your own product, including caching, is permitted;
  reselling the raw feed needs written approval; the vendor supplies data for betting products but "does not supply
  your gambling licence"; it is not an official rights holder. See appendix A2. This reads friendlier to an operator
  than API-Football, but a person still needs it in writing.
- **Fit.** Token goes in an `api_token` query parameter or a header. A query-parameter token would validate in our
  config but would then sit in the stored source config, the raw archive and logs: not recommended. Its fixture
  JSON lists teams in a nested `participants` array, which the path syntax cannot select by role (home or away);
  fit unverified.
- **Verdict: possible, fallback**, only after a free trial shows the league and an engineer confirms the fit.

### 3.7 Other providers

- **football-data.org.** Free tier is 12 competitions, 10 calls a minute, delayed scores; Costa Rica not named in
  any result. No commercial-use clause found. Do not use.
  [coverage and limits summary](https://www.thestatsapi.com/blog/football-data-org-free-tier-limits-2026) (a
  competitor's blog, not the vendor).
- **TheSportsDB.** Free key is the public test key and is for development only; paid keys 9 and 20 USD a month;
  data is crowd-sourced; reselling needs permission. [pricing](https://www.thesportsdb.com/pricing),
  [terms](https://www.thesportsdb.com/docs_terms_of_use.php). Do not use for settlement.
- **Sportradar, Stats Perform, Genius Sports.** Enterprise contracts, no public price. Nothing found says
  Sportradar or Stats Perform holds Costa Rican rights (Stats Perform's Latin American deals found were Colombia's
  DIMAYOR and Ecuador's LigaPro). Genius Sports is UNAFUT's data and integrity partner since 2020, which suggests
  it is the route to **official betting data** for Liga Promerica, if that is wanted; confirm by asking.
  [Genius release](https://news.geniussports.com/costa-rican-football-appoints-genius-sports-to-lead-live-data-and-integrity-strategy/).

## 4. Recommendation

**Run these two in shadow mode first, plus a fallback.**

| Role                           | Source                                                               | Upstream to record                               | Why                                                                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary (official)             | UNAFUT site, `generic-html`                                          | `UNAFUT / Genius Sports LiveStats`               | The league's own page, free, the closest thing to ground truth, and carries the club ids and matchday labels                                                                     |
| Second (licensed, independent) | API-Football Pro, `generic-json`                                     | `API-Sports own collection` (confirm in writing) | A paid feed (no SLA was checked) with stable fixture ids, ISO kickoffs with offsets and separate 90-minute, extra-time and penalty scores; 19 USD a month; no scraping of a site |
| Fallback                       | Sportmonks Starter, else a Sportradar / Stats Perform / Genius quote | its own                                          | Used if API-Football's coverage, licence or upstream answer is wrong                                                                                                             |
| Last resort                    | One upstream plus traders confirming                                 | n/a                                              | Rule R6: the engine applies nothing from one upstream by itself                                                                                                                  |

Why two with "different upstreams" is a **claim to verify, not a fact**: if API-Sports takes its Costa Rican
results from UNAFUT's Genius feed, the pair is one vote for rule R2. Ask the vendor (step A4 below). If the
answer is "same feed", the second source must be something else (Sportmonks, Sportradar).

Why API-Football over the others: coverage of "all competitions" on every plan, a fixed low price, documented score
fields, and no site markup to break. Why not the free plan: 100 requests a day against about 100 to 300 needed.

Run the competition policy off (shadow mode), `extra_time` on from 9 December, then the enabling order in
[plan 07](07-sources-ratings-and-shadow-mode.md).

## 5. What the person must do before each source can be enabled

Nothing below has been done, and none of it can be done by the repository tooling.

### UNAFUT site

1. Read, on the live site, the terms of use (if any), the privacy policy and `https://www.unafut.com/robots.txt`,
   for every host the pages and any data endpoints come from. Quote the clause on automated access, the date and
   your name in the change ticket. If automated access is forbidden or the robots file disallows the pages: stop,
   and do not use the source.
2. Write to UNAFUT (see [contact](https://www.unafut.com/contacto/)) asking permission for polite automated reading
   of the calendar and results, and whether an official data licence for betting operators exists (and whether it
   goes through Genius Sports). Keep the answer.
3. Hand an engineer saved pages (a finished matchday and an upcoming one) so the selectors in
   `data/source-unafut.json` can be written and tested with `dry-parse`, then `dry-fetch`.
4. Set `SCRAPER_CONTACT` (required in licensed mode).
5. Legal sign-off on the terms and robots decision.

### API-Football

1. Sign up at the vendor's dashboard (free), accept its terms, and with the free key call `/leagues?country=Costa-Rica`
   and `/fixtures?league=162&season=2026` (confirm the league id and the season value) and check the half-time
   scores, the `fixture.id`s and which seasons the free plan can read.
2. **Ask API-Sports in writing:** (a) may a licensed betting operator use the data to create events, set prices
   and settle bets; (b) where does its Costa Rican data come from (the upstream); (c) is there an SLA and how
   quickly are final scores posted.
3. Buy the **Pro plan (19 USD a month)** only after steps 1 and 2 are acceptable. Store the key as a secret in the
   deployment environment; never in git, the source file or the database.
4. Have an engineer add the optional request-header support to `generic-json` (key from the environment) and a
   test. Until then this source cannot be configured.
5. Legal sign-off on the terms.

### Both

- Record each source's upstream in `upstream` and in the shadow scorecard (`shadow-scorecard-<competition>.md`).
- Confirm the club list for the competition with UNAFUT, seed the catalogue teams (see
  `data/costa-rica-teams.csv`), import aliases, then follow the [runbook](../runbooks/feed-new-source.md).
- Remember the catalogue has no Costa Rican competition or clubs yet. Suggested competition slug:
  `costa-rica-primera-division`.

## 6. Ratings history and its validation

**Status: not transcribed. `data/costa-rica-history.json` does not exist and nothing was committed.**

Why: results need to be read from the season articles (Wikipedia, CC BY-SA 4.0). The fetcher could not reach
Wikipedia in this session, and the search tool returns only summaries (a few matchday-1 scores, the top of the
standings), not 90 matches per tournament. Transcribing from memory or from summaries would put unreconciled numbers
into the ratings, which the brief rules out.

What is known (search summaries of the es.wikipedia Apertura 2025 article, **unverified**), usable as check values:
Alajuelense 1st, 40 points from 18 played, 12 won, 4 drawn, 2 lost, goals 29 for 10 against; Saprissa 2nd with 34
points (goal difference +12); Cartaginés 28 points; Municipal Liberia 27; Herediano 26; San Carlos and Guadalupe
last with 13 points each. These rows are internally consistent (3 x 12 + 4 = 40; 29 - 10 = 19). The 2025-26 season
had 10 clubs, so each tournament has 90 matches.

What to do when the pages are reachable (about an hour):

1. Read the regular-season result grid and the final table of **Apertura 2025** and **Clausura 2026** (English
   page for the season above, Spanish pages per tournament). Only the 18 matchdays count; leave out semifinals,
   finals and Gran Finals (they can go to extra time).
2. Write `docs/scraper-plan/data/costa-rica-history.json` as an array of
   `{ "date": "YYYY-MM-DD", "home": "...", "away": "...", "homeGoals": 0, "awayGoals": 0 }` (the strict format of
   `ratings backfill`: no other keys, at least one row, a real date, home not equal to away). 180 rows expected.
   Dates come from the matchday tables; if only the matchday date is known, the matchday date is fine (the replay
   needs order, and equal dates keep file order).
3. **Team names.** The CLI resolves names only through the catalogue (team short name or any localized name),
   **not through aliases**. So the file must use the catalogue short names (the `proposed_short_name` column of
   `data/costa-rica-teams.csv`), or those names must exist in the catalogue; the brief's "names as on the source"
   would fail with "unknown team". Keep a mapping from the source's spelling to the short name next to the file.
4. **Validate before committing.** From the file alone compute, per team, played / won / drawn / lost / goals
   for / goals against / points, and compare with the published table of each tournament. Expected: every team 18
   played, the 10 teams' wins equal losses in total, goals for equal goals against in total, and every row equal
   to the table. List and fix every mismatch (a wrong score, a swapped home and away, a missing match). Do not
   commit a file with any unexplained difference. Then run
   `ratings backfill --file ... --competition costa-rica-primera-division --dry-run` against a database with the
   teams seeded.
5. Add the attribution note in this section: article URLs with their revision, "CC BY-SA 4.0", the date read, and
   that the scores were transcribed. Share-alike applies to the transcribed text; the results are facts, but the
   note should still name the source.
6. The file also contains Municipal Liberia and Guadalupe, which are probably not in the Apertura 2026
   (section 2): seed them as teams (they have `matches` counts but no upcoming fixtures) or the backfill refuses
   with "unknown team".

Note for traders: ratings need `matches >= SCRAPER_MIN_RATING_MATCHES` (8). The clubs have already played about 13
matches in the Apertura 2026, but those results only count if the scraper is running and applying them; that is why
the backfill is wanted.

## 7. Draft source files

These are drafts. Nothing loads them. Both pass the repository's own config check
(`createAdapter`, through `dry-parse`); that proves they are well-formed, not that they are right.

| File                            | Adapter        | What is verified                                                                                                                                                                                              | What is not                                                                                                                                                                                                                          |
| ------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `data/source-api-football.json` | `generic-json` | Config schema; a hand-made document in the shape I remember of the vendor's v3 response was parsed correctly (FT to a regular-time result with half-time, NS to a fixture, AET dropped with `unknown_status`) | Every field path and status code is from memory of the vendor's documentation; the league id 162 and `season=2026` are unverified; the key is not in the file (no key is invented) and the adapter cannot send one yet (section 3.5) |
| `data/source-unafut.json`       | `generic-html` | Config schema; `dry-parse` against an empty page reports `no_items` as it should                                                                                                                              | **All selectors, the calendar URL, the date format and the status text are placeholders** (`REPLACE`). Host `www.unafut.com`; time zone `America/Costa_Rica`                                                                         |

Choices in them, for the person to confirm:

- **Cadence** is not part of the source file: the runner polls fixtures every 15 minutes and results every 5
  minutes from kickoff plus 90 minutes (otherwise hourly), for every source. At that rate API-Football needs the
  Pro plan.
- **Status mapping (API-Football).** Not-started and live codes map to `scheduled` (a fixture observation only);
  `FT` maps to `finished`; `PST`, `CANC`, `ABD` to the void statuses. **`AET`, `PEN` and the technical-loss codes
  are left out on purpose**, so extra-time matches are never settled by this source on its own (fails closed:
  the record is dropped with an issue and a person decides).
- **Score basis.** Both drafts say `regular_time`. For API-Football the path is `score.fulltime`, which I believe is
  the 90-minute score; verify with a saved extra-time match. For UNAFUT nothing is known: if its page shows the
  score after extra time for a second leg, use `includes_extra_time` for that source.
- **Competition label** is fixed as `Liga Promerica`: import it as a competition alias to the slug above.
- The `upstream` text is limited to 100 characters.

## Appendix A. Quotes and dates

All read on **2026-10-29** through the web search tool (the page fetcher was blocked). Quotation marks mean the
search tool printed the words as a quotation from the page. They are **not** a substitute for reading the live
page. No `robots.txt` was read for any host.

### A1. API-Football

From [terms](https://www.api-football.com/terms) (the search metadata said the cached copy was about 586 days old):

> The use of our data for betting platforms, television broadcasting, fantasy sports platforms, or any mass media distribution may require additional licenses from the relevant rights holders.

> Users must ensure their use complies with applicable legal and commercial restrictions.

> it is prohibited to resell this data to third parties or to use the services provided for illegal purposes

Also reported: the vendor "gives no license for publishing its data" in user applications. The sister site
[api-sports.io/terms](https://api-sports.io/terms) says third-party rights holders such as leagues may restrict
commercial use and that the vendor "does not grant any commercial rights on such competitions".

Pricing, from [api-football.com/pricing](https://www.api-football.com/pricing): Free 0 USD, 100 a day; Pro 19 USD,
7,500 a day; Ultra 29 USD, 75,000 a day; Mega 39 USD, 150,000 a day; "all our pricing plans include all competitions
and endpoints"; free plans "limited in terms of available seasons".

### A2. Sportmonks

From the [terms](https://www.sportmonks.com/terms-of-service/) and
[integrity page](https://www.sportmonks.com/integrity-support/), as printed by the search tool:

> Storing, transferring and distributing the data inside your own product is explicitly permitted by our terms of service, including caching it in your own database.

> Sportmonks.com is not responsible for any winnings made or losses suffered on third-party websites/applications that use Sportmonks' data.

Paraphrased by the search tool, not quoted: reselling or redistributing the raw feed needs prior written approval;
"what we do not supply is your gambling licence"; Sportmonks is not an official rights holder.
Pricing: [plans](https://www.sportmonks.com/football-api/plans-pricing/).

### A3. Wikimedia

[API usage guidelines](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_API_Usage_Guidelines), as
printed by the search tool: operators must "Follow the User-Agent policy and otherwise correctly label user agents;
Follow rate limiting requests (e.g., throttling notification) you may receive; Follow the requirements of the
content licenses when republishing downloaded or cached data; and Follow the robot policy if your software is
automatically consuming content at a large scale." Wikipedia text licence: CC BY-SA 4.0 (the page footer; the
reuse guide itself was not retrieved).

### A4. UNAFUT and Genius Sports

[Genius Sports, February 2020](https://news.geniussports.com/costa-rican-football-appoints-genius-sports-to-lead-live-data-and-integrity-strategy/):
UNAFUT partnered with Genius Sports; "Football LiveStats" runs pitch-side at every UNAFUT game and feeds the
website, an app and automated social posts; a Bet Monitoring System watches for betting-related manipulation. The
announcement is about six years old.

UNAFUT site: footer credits Genius Sports Group; the About page describes UNAFUT as the league body
([about](https://www.unafut.com/acerca-unafut/)). No terms of use or robots text was seen.

### A5. Media terms

- Teletica, [teletica.com/terminos](https://www.teletica.com/terminos) (paraphrase): a limited licence; users may
  not copy, print, publish, distribute, sell, or otherwise exploit any portion of the material; terms may change
  without notice.
- CRHoy, [crhoy.com/politicas-de-privacidad](https://crhoy.com/politicas-de-privacidad/): "CRHoy, crhoy.com y el
  logo de crhoy.com noticias 24/7 son marcas registradas y se prohíbe totalmente su uso o reproducción sin previa
  autorización por escrito."
- Grupo Nación, [corporate pages](https://www.nacion.com/gnfactory/especiales/gruponacion/privacidad.html):
  "© Todos los derechos reservados, cualquier uso requiere autorización expresa y por escrito de Grupo Nación GN S.A."

### A6. TheSportsDB

[Pricing](https://www.thesportsdb.com/pricing) and [terms](https://www.thesportsdb.com/docs_terms_of_use.php), as
paraphrased: free key `123` is for development; publishing an app needs a paid plan (9 and 20 USD a month);
reselling the API needs permission; data must be credited to TheSportsDB.

### A7. Competition rules

[Fútbol Centroamérica: how the final is decided](https://futbolcentroamerica.com/costarica/herediano-vs-saprissa-como-se-define-la-final-si-empatan-en-el-global):
no away-goals criterion in the final phase or a Gran Final; a tied aggregate goes to two extra-time periods of 15
minutes and then penalties. [Teletica on semifinals](https://www.teletica.com/municipal-liberia/gol-de-visita-es-criterio-de-desempate-en-una-semifinal-esto-dice-el-reglamento_398699):
article 95 of the 2025-26 competition rules is reported to require extra time and, if needed, penalties for a
tied two-legged series. The rulebook text itself was not read.

### A8. Things I could not verify

- `robots.txt` of every host; the full terms of UNAFUT, Fedefútbol, the media, aggregators and every vendor.
- Whether `unafut.com` has a whole-league results page, a JSON endpoint, half-time scores, or a stable match id.
- Whether API-Football covers Liga Promerica for 2026, its league id, field paths, status codes and score
  semantics, and what it says about betting operators in the current terms.
- Sportmonks, Sportradar, Stats Perform and Genius Sports coverage of this league, prices beyond Sportmonks' public
  list, and any betting-operator licence terms.
- The club list of the 2026-27 season (Liberia, Guadalupe, Escorpiones, Inter San Carlos, San Carlos licence).
- The Clausura 2027 start date, and the exact name variants each source uses for each club.
- All match results and standings for the ratings history.
