#!/usr/bin/env bash
# A read-only study of the scraper's review queue (owner, 23 Nov 2026: which items could resolve
# by themselves). Run on the server; it reads the database and the scraper's log, changes nothing,
# writes /root/review-study.txt and prints it. From the owner's PC:
#
#   ssh root@<server> "cd /opt/nahubet && git fetch -q origin <branch> && git show origin/<branch>:scripts/review-study.sh | bash"
set -u
OUT="${REVIEW_STUDY_OUT:-/root/review-study.txt}"
PG="${REVIEW_STUDY_PG:-vamos-postgres-1}"
SCRAPER="${REVIEW_STUDY_SCRAPER:-vamos-scraper-1}"

{
  docker exec -i "$PG" psql -U vamos -d vamos -X -q -v ON_ERROR_STOP=0 <<'SQL'
\pset pager off
\echo '== A. open items by kind and severity'
select kind, severity, count(*) n, min(created_at)::date oldest, max(created_at)::date newest
from scrape_review_items where status = 'open' group by 1, 2 order by 3 desc;

\echo '== B. reasons (sub = reprice / earlier items of an event)'
select kind,
       case when subject_key like '%|reprice' then 'reprice' when subject_key like '%|earlier' then 'earlier' else '' end sub,
       payload->>'reasons' reasons, count(*) n
from scrape_review_items where status = 'open' group by 1, 2, 3 order by 4 desc limit 40;

\echo '== C. state of the match behind each item'
select r.kind,
       case when e.id is null then 'no match'
            when e.status <> 'scheduled' then 'match ' || e.status
            when e.start_time <= now() then 'kicked off'
            when e.betting_open then 'upcoming, betting open'
            else 'upcoming, betting closed' end state,
       count(*) n
from scrape_review_items r
left join events e on e.feed_ref = regexp_replace(r.subject_key, '\|(reprice|earlier)$', '')
where r.status = 'open' group by 1, 2 order by 1, 3 desc;

\echo '== D. upcoming matches with betting closed, per league, by what holds them'
select c.slug, coalesce(r.kind || coalesce(' ' || (r.payload->>'reasons'), ''), '(nothing open)') held_by,
       count(distinct e.id) matches
from events e
join competitions c on c.id = e.competition_id
left join scrape_review_items r
  on r.status = 'open' and regexp_replace(r.subject_key, '\|(reprice|earlier)$', '') = e.feed_ref
where e.status = 'scheduled' and e.start_time > now() and not e.betting_open
group by 1, 2 order by 1, 3 desc;

\echo '== E. re-prices held for a person (sample)'
select left(payload::text, 900) from scrape_review_items
where status = 'open' and kind = 'odds_approval' and subject_key like '%|reprice'
order by created_at desc limit 3;

\echo '== F. requests to open betting (sample)'
select payload->>'reasons' reasons, left(payload::text, 600) from scrape_review_items
where status = 'open' and kind in ('odds_approval', 'ratings_uncalibrated') and subject_key not like '%|reprice'
order by created_at desc limit 4;

\echo '== G. kickoff changes (sample)'
select payload->>'reasons' reasons, left(payload::text, 700) from scrape_review_items
where status = 'open' and kind = 'kickoff_change' order by created_at desc limit 4;

\echo '== H. unknown teams'
select title, count(*) n from scrape_review_items
where status = 'open' and kind = 'unknown_team' group by 1 order by 2 desc limit 15;
select left(payload::text, 500) from scrape_review_items
where status = 'open' and kind = 'unknown_team' order by created_at desc limit 3;

\echo '== I. results waiting'
select kind, payload->>'reasons' reasons, count(*) n, min(created_at)::date oldest
from scrape_review_items where status = 'open' and kind like 'result%' group by 1, 2 order by 3 desc;
select kind, left(payload::text, 600) from scrape_review_items
where status = 'open' and kind in ('result_ready', 'result_unverified', 'result_overdue')
order by created_at desc limit 5;

\echo '== J. fixtures missing and conflicts'
select kind, title, count(*) n from scrape_review_items
where status = 'open' and kind in ('fixture_missing', 'fixture_conflict') group by 1, 2 order by 3 desc limit 10;

\echo '== K. sources'
select id, adapter, enabled, left(config::text, 200) config from scrape_sources order by adapter, id;

\echo '== L. competition policies'
select c.slug, p.enabled, p.auto_open, p.auto_results, p.extra_time, p.pricing_source, p.factory_markets
from scrape_competition_policy p join competitions c on c.id = p.competition_id order by c.slug;
SQL
  echo '== M. scraper passes (last 3 hours)'
  docker logs --since 3h "$SCRAPER" 2>&1 \
    | grep -E 'auto open run|review sweep|reprice|results run|promote' | tail -12 | cut -c1-300
} > "$OUT" 2>&1

cat "$OUT"
echo
echo "(saved to $OUT)"
