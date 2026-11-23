# Feed and review-queue report from the production server, run from the owner's PC (PowerShell 7):
#
#   pwsh -File scripts\feed-report.ps1
#
# It logs in to the server once (you type the password), runs READ-ONLY queries and log reads there, and
# saves the output to feed-report.txt on your Desktop. It changes nothing on the server and prints no
# secrets and no player data: only service status, feed sources, review-queue counts and titles,
# competitions, match counts, bookmaker-price counts, rating and alias counts, and recent warnings;
# and, as on the back office's Feed page, the mr-x (Hulusport) and mr-z (Narobet) boards, the feed
# switches, matches by feed, held and suspended prices, market families, the services' health, and
# mr-x and mr-z as the scraper reaches them (status and a summary only: their addresses are secret).
# Sections for features not deployed yet say so instead of failing.
param(
  [string]$Server = 'root@13.140.208.4',
  [string]$Out = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'feed-report.txt')
)

$remote = @'
cd /opt/nahubet-new || { echo "no /opt/nahubet-new on this server"; exit 1; }
export COMPOSE_FILE=infra/docker-compose.prod.yml COMPOSE_ENV_FILES=infra/.env.prod
echo "===== 0. Server: $(date -u '+%Y-%m-%d %H:%M UTC'), services"
docker compose ps --format '{{.Service}} {{.Status}}'
echo "feed scripts still running: $(pgrep -fc 'infra/scripts/' || true)"
echo "public API health: $(curl -s -o /dev/null -w '%{http_code}' https://api.nahubet.com/health)"
docker exec -i vamos-postgres-1 sh -c 'psql -X -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -P footer=off' <<'SQL'
\echo ===== 1. Operating mode of the database
select operating_mode, claimed_at::date as since from database_identity;
\echo ===== 2. Feed sources (enabled = switched on in the back office)
select id, adapter, upstream, enabled from scrape_sources order by id;
\echo ===== 3. Latest run of each source
select distinct on (source_id) source_id, status, to_char(started_at, 'MM-DD HH24:MI') as started,
  records_seen as seen, records_accepted as accepted, fixtures, results,
  api_credits_remaining as credits_left, left(coalesce(error, ''), 70) as error
from scrape_runs order by source_id, started_at desc;
\echo ===== 4. Runs in the last 24 hours, by status
select source_id, status, count(*) from scrape_runs
where started_at > now() - interval '24 hours' group by 1, 2 order by 1, 2;
\echo ===== 5. Review queue by kind and status
select kind, status, severity, count(*) from scrape_review_items group by 1, 2, 3 order by 1, 2, 3;
\echo ===== 6. Newest open review items per kind (up to 15 each)
select kind, left(title, 120) as title from (
  select kind, title, row_number() over (partition by kind order by created_at desc) as rn
  from scrape_review_items where status = 'open') t
where rn <= 15 order by kind, rn;
\echo ===== 7. Competition feed settings
select c.slug, p.enabled, p.auto_open, p.auto_results, p.pricing_source
from scrape_competition_policy p join competitions c on c.id = p.competition_id order by c.slug;
\echo ===== 8. Matches by competition and status
select c.slug, e.status::text as status, count(*) as matches, count(*) filter (where e.betting_open) as betting_open,
  to_char(min(e.start_time), 'MM-DD') as first, to_char(max(e.start_time), 'MM-DD') as last
from events e join competitions c on c.id = e.competition_id group by 1, 2 order by 1, 2;
\echo ===== 9. Matches in the next 7 days
select count(*) as matches, count(*) filter (where betting_open) as betting_open
from events where start_time between now() and now() + interval '7 days';
\echo ===== 10. Source rows not matched to a catalogue competition or team
select source_id, kind, count(*) as rows, count(*) filter (where competition_id is null) as no_competition,
  count(*) filter (where home_team_id is null or away_team_id is null) as no_team
from scrape_observations group by 1, 2 order by 1, 2;
\echo ===== 11. Bookmaker prices received
select bookmaker, count(*) as prices, count(distinct event_id) as matched_events,
  to_char(max(observed_at), 'MM-DD HH24:MI') as latest
from scrape_market_odds group by 1 order by 2 desc limit 15;
\echo ===== 12. Team ratings
select (ratings is not null) as has_ratings, count(*) as teams from teams group by 1;
select k as rating_field, count(*) as teams
from teams, jsonb_object_keys(coalesce(ratings, '{}'::jsonb)) k group by 1 order by 2 desc limit 12;
\echo ===== 13. Aliases (source spellings mapped to catalogue names)
select 'team aliases' as what, count(*) from team_aliases
union all select 'competition aliases', count(*) from competition_aliases;
\echo ===== 16. Why odds approvals and calibration items wait (stage, rules, reasons)
select kind,
  case when subject_key like '%|reprice' then 'reprice hold'
       when position('|' in subject_key) > 0 then split_part(subject_key, '|', 2)
       else 'at creation' end as stage,
  coalesce(payload->>'rules', '') as rules, coalesce(payload->>'reasons', '') as reasons,
  coalesce(payload->>'kickoffConfirmed', '') as kickoff_ok, coalesce(payload->>'pricesSane', '') as prices_ok,
  count(*)
from scrape_review_items where status = 'open' and kind in ('odds_approval', 'ratings_uncalibrated')
group by 1, 2, 3, 4, 5, 6 order by count(*) desc;
\echo ===== 17. Re-price holds: the top reasons
select left(payload->>'reason', 110) as reason, count(*) from scrape_review_items
where status = 'open' and kind = 'odds_approval' and payload ? 'reason' group by 1 order by 2 desc limit 12;
\echo ===== 18. Every open unknown name, with its source
select kind, coalesce(payload->>'sourceId', '') as source, left(title, 90) as title from scrape_review_items
where status = 'open' and kind in ('unknown_team', 'unknown_competition') order by 1, 2, 3;
\echo ===== 19. Fixture conflicts: what the sources disagree about
select coalesce(payload->>'reasons', '') as reasons, left(coalesce(payload->>'detail', ''), 150) as detail
from scrape_review_items where status = 'open' and kind = 'fixture_conflict';
\echo ===== 20. Teams in matches of the next 14 days whose ratings are not calibrated (fewer than 8 matches, not manual)
select distinct t.short_name, c.slug as competition, coalesce(t.ratings->>'matches', '-') as matches,
  coalesce(t.ratings->>'manual', '-') as manual
from events e join competitions c on c.id = e.competition_id
join teams t on t.id in (e.home_team_id, e.away_team_id)
where e.start_time between now() and now() + interval '14 days'
  and coalesce(t.ratings->>'manual', '0') <> '1'
  and coalesce((t.ratings->>'matches')::numeric, 0) < 8
order by 2, 1;
\echo ===== 14. Results
select count(*) filter (where resulted_at is not null) as resulted,
  count(*) filter (where resulted_at is null and start_time < now() - interval '3 hours') as past_kickoff_no_result
from events;
\echo ===== 21. What the database has: migrations applied
select to_regclass('drizzle.__drizzle_migrations') is not null as has_migrations \gset
\if :has_migrations
select count(*) as migrations_applied, to_char(to_timestamp(max(created_at) / 1000), 'YYYY-MM-DD HH24:MI') as newest
from drizzle.__drizzle_migrations;
\else
\echo (no migration journal found)
\endif
\echo ===== 22. Feed switches (back office Feed page; changed = when)
select key, left(value::text, 120) as value, to_char(updated_at, 'MM-DD HH24:MI') as changed from settings
where key in ('hulusport_pricing', 'narobet_pricing', 'narobet_events', 'board_risk_limits') order by key;
\echo ===== 23. Board prices (mr-x = hulusport, mr-z = narobet): rows, linked to our matches, fresh
select board, count(*) as rows, count(*) filter (where kickoff > now()) as upcoming,
  count(*) filter (where kickoff > now() and event_id is not null) as upcoming_linked,
  count(*) filter (where kickoff > now() and event_id is null) as upcoming_unlinked,
  count(*) filter (where kickoff > now() and (home_team_id is null or away_team_id is null)) as upcoming_team_unknown,
  count(*) filter (where prices_at > now() - interval '20 minutes') as prices_20min,
  count(*) filter (where prices_at > now() - interval '2 hours') as prices_2h,
  to_char(max(prices_at), 'MM-DD HH24:MI') as newest_prices, to_char(max(observed_at), 'MM-DD HH24:MI') as last_read
from scrape_board_odds group by board order by board;
\echo ===== 24. Age of the board prices by how soon the match starts (minutes; mr-z prices are used up to 20 min old within 3 h, 45 min within 24 h, 7 h beyond)
select board,
  case when kickoff < now() + interval '3 hours' then 'a. under 3 h'
       when kickoff < now() + interval '24 hours' then 'b. 3 to 24 h'
       when kickoff < now() + interval '7 days' then 'c. 1 to 7 days' else 'd. over 7 days' end as starts_in,
  count(*) as matches, count(*) filter (where event_id is not null) as linked,
  round(percentile_cont(0.5) within group (order by extract(epoch from now() - prices_at) / 60)) as median_age_min,
  round(max(extract(epoch from now() - prices_at) / 60)) as oldest_min
from scrape_board_odds where kickoff > now() group by 1, 2 order by 1, 2;
\echo ===== 25. Upcoming board matches not linked to a match of ours, by board competition (top 25)
select board, left(competition_raw, 60) as competition, count(*) as matches,
  count(*) filter (where home_team_id is null or away_team_id is null) as team_unknown
from scrape_board_odds where kickoff > now() and event_id is null group by 1, 2 order by 3 desc limit 25;
\echo ===== 26. Board names mapped to our catalogue
select 'competitions' as what, board, count(*) from scrape_board_competitions group by 1, 2
union all select 'teams', board, count(*) from scrape_board_teams group by 1, 2 order by 1, 2;
\echo ===== 27. Our matches of the next 7 days by feed (feed_provider)
select feed_provider, count(*) as matches, count(*) filter (where betting_open) as betting_open,
  count(*) filter (where status::text = 'scheduled') as scheduled
from events where start_time between now() and now() + interval '7 days' group by 1 order by 2 desc;
\echo ===== 28. Matches of the next 7 days: prices held or suspended, and why
select coalesce(p.suspended_for::text, '-') as suspended_for, (p.held_key is not null) as held, count(*)
from scrape_event_pricing p join events e on e.id = p.event_id
where e.start_time between now() and now() + interval '7 days' group by 1, 2 order by 3 desc;
\echo ===== 29. Matches of the next 48 hours by competition: open for betting, open markets
select c.slug, count(distinct e.id) as matches, count(distinct e.id) filter (where e.betting_open) as open_matches,
  count(m.id) filter (where m.status::text = 'open') as open_markets,
  count(m.id) filter (where m.status::text = 'suspended') as suspended_markets
from events e join competitions c on c.id = e.competition_id left join markets m on m.event_id = e.id
where e.start_time between now() and now() + interval '48 hours' group by 1 order by 2 desc limit 30;
\echo ===== 30. Market families (the weekly margin watch)
select to_regclass('public.market_family_state') is not null as has_families \gset
\if :has_families
select family, status, raised_margin_bps, since_week, to_char(updated_at, 'MM-DD') as changed
from market_family_state order by status, family;
\else
\echo (not on this server yet)
\endif
\echo ===== 31. Services (back office Service health)
select to_regclass('public.service_status') is not null as has_service_status \gset
\if :has_service_status
select service, to_char(last_ok_at, 'MM-DD HH24:MI') as last_ok, to_char(failing_since, 'MM-DD HH24:MI') as failing_since,
  to_char(alerted_down_since, 'MM-DD HH24:MI') as owner_told, left(coalesce(last_error, ''), 80) as last_error
from service_status order by service;
\else
\echo (not deployed yet: migration 0078)
\endif
\echo ===== 32. Board-match results (API-Football by fixture, cross-checked with mr-z)
select to_regclass('public.scrape_board_results') is not null as has_board_results \gset
\if :has_board_results
select status, count(*), to_char(max(last_seen_at), 'MM-DD HH24:MI') as latest from scrape_board_results group by 1 order by 2 desc;
\else
\echo (not on this server yet)
\endif
SQL
echo "===== 15. Warnings and errors in the scraper and worker logs (last 24 hours, newest 25)"
docker compose logs --since 24h --no-color scraper worker 2>&1 | grep -E '"level":(40|50)|[Ee]rror' | tail -25 | cut -c1-230
echo "===== 33. What the scraper logged in the last 6 hours (messages, most frequent first)"
docker compose logs --since 6h --no-color scraper 2>&1 | grep -o '"msg":"[^"]*"' | sort | uniq -c | sort -rn | head -25
echo "===== 34. Warnings and errors by message in the last 24 hours (scraper, worker, api)"
docker compose logs --since 24h --no-color scraper worker api 2>&1 | grep -E '"level":(40|50)' \
  | grep -o '"msg":"[^"]*"' | sort | uniq -c | sort -rn | head -20
echo "===== 35. mr-z and mr-x as the scraper reaches them (status and a summary; addresses are not printed)"
docker compose exec -T scraper node -e '
const clean = (v) => JSON.stringify(v, (k, x) => (typeof x === "string" && /https?:|@/.test(x) ? "[hidden]" : x));
const probe = async (name, env, path, pick) => {
  const base = (process.env[env] || "").replace(/\/$/, "");
  if (!base) { console.log(name + ": not configured"); return; }
  try {
    const r = await fetch(base + path, { signal: AbortSignal.timeout(10000) });
    const text = await r.text();
    let summary = "(not JSON)";
    try { summary = pick(JSON.parse(text)); } catch {}
    console.log(name + ": HTTP " + r.status + " " + summary.slice(0, 500));
  } catch (e) { console.log(name + ": unreachable (" + ((e.cause && e.cause.code) || e.name) + ")"); }
};
(async () => {
  await probe("mr-z health", "SCRAPER_NAROBET_URL", "/api/health", (j) => clean(j));
  await probe("mr-x board", "SCRAPER_HULUSPORT_URL", "/api/board", (j) =>
    clean({ generated_at: j.generated_at, worker: j.worker, matches: Array.isArray(j.matches) ? j.matches.length : null }));
})();' 2>&1 | cut -c1-600
echo "===== 36. mr-z on this server (container and its last poller lines)"
mrz=$(docker ps --format '{{.Names}}' | grep -iE 'mr-?z' | head -1)
if [ -n "$mrz" ]; then
  docker ps --filter "name=$mrz" --format '{{.Names}} {{.Status}}'
  docker logs --since 6h "$mrz" 2>&1 | tail -8 | cut -c1-200
else
  echo "no mr-z container on this server"
fi
'@

# Strip Windows line endings before sending: bash on the server cannot read them.
$bytes = [Text.Encoding]::UTF8.GetBytes(($remote -replace "`r", ''))
$encoded = [Convert]::ToBase64String($bytes)
# The server sends UTF-8 (Turkish and Amharic names): read it as UTF-8, not the console default code page.
$previousEncoding = [Console]::OutputEncoding
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Write-Host "Connecting to $Server (type the server password when asked)..."
ssh $Server "echo $encoded | base64 -d | bash" 2>&1 | Tee-Object -FilePath $Out
[Console]::OutputEncoding = $previousEncoding
Write-Host ""
Write-Host "Saved to $Out"
