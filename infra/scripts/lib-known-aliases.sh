# Sourced by use-odds-api.sh, add-more-competitions.sh and add-more-leagues.sh (not run on its own).
#
# import_known_odds_aliases SOURCE_ID...
#   Imports the rows of docs/scraper-plan/data/aliases-theoddsapi-known.csv whose source is one of
#   the given source ids: The Odds API spellings seen in production that neither the catalogue
#   names nor the legal-form fallback resolve. A row is scoped to a source, and the import refuses
#   a row whose source does not exist (and then writes nothing), so only the sources this run
#   added are passed. Safe to run again: rows that exist are counted, not rewritten. Needs the
#   caller's COMPOSE_FILE and a repo-root working directory.
import_known_odds_aliases() {
  (($# > 0)) || return 0
  local csv=docs/scraper-plan/data/aliases-theoddsapi-known.csv tmp ids
  tmp="$(mktemp -d)"
  chmod 755 "$tmp" # the scraper container reads the file as its own user
  ids="$(IFS='|' && echo "$*")"
  awk -F, -v pattern="^(${ids})\$" 'NR == 1 || $5 ~ pattern' "$csv" >"$tmp/aliases.csv"
  chmod 644 "$tmp/aliases.csv"
  if (($(wc -l <"$tmp/aliases.csv") > 1)); then
    echo "==> The Odds API's known club spellings for the sources added"
    docker compose run --rm -T --no-deps -v "$tmp:/known:ro" scraper \
      node dist/cli.js aliases import --file /known/aliases.csv </dev/null || {
      echo "Needs a look: the known club spellings were not imported (see above)" >&2
    }
  fi
  rm -rf "$tmp"
}
