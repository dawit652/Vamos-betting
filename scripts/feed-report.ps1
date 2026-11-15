# Feed and review-queue report from the production server, run from the owner's PC (PowerShell 7):
#
#   pwsh -File scripts\feed-report.ps1
#
# It logs in to the server once (you type the password), runs READ-ONLY queries and log reads there, and
# saves the output to feed-report.txt on your Desktop. It changes nothing on the server and prints no
# secrets and no player data: only service status, feed sources, review-queue counts and titles,
# competitions, match counts, bookmaker-price counts, rating and alias counts, and recent warnings.
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
SQL
echo "===== 15. Warnings and errors in the scraper and worker logs (last 24 hours, newest 25)"
docker compose logs --since 24h --no-color scraper worker 2>&1 | grep -E '"level":(40|50)|[Ee]rror' | tail -25 | cut -c1-230
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
