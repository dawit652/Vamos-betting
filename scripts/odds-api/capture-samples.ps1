<#
  Captures real samples from The Odds API (v4) for the Vamos integration
  (docs/odds-api-integration-plan.md). Uses about 30 credits of the quota.
  Your API key is never printed or written to disk.

  Run (Windows PowerShell 5.1 or PowerShell 7):
    $env:ODDS_API_KEY = '<your key>'      # or leave unset to be asked for it
    powershell -ExecutionPolicy Bypass -File .\capture-samples.ps1

  Output: .\odds-api-samples\*.json (full responses) and summary.txt, which is
  also copied to the clipboard so it can be pasted into the chat.
#>
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = 'Stop'

$key = $env:ODDS_API_KEY
if (-not $key) {
  $secure = Read-Host 'The Odds API key (hidden)' -AsSecureString
  $key = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
if (-not $key) { throw 'No API key given.' }

$base = 'https://api.the-odds-api.com/v4'
$outDir = Join-Path (Get-Location) 'odds-api-samples'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$summary = New-Object System.Collections.Generic.List[string]

function Add-Line([string]$text) { $summary.Add($text.Replace($key, '***')) }

function ConvertTo-Compact($value) { ConvertTo-Json -InputObject $value -Depth 20 -Compress }

# PowerShell 7 turns ISO strings into DateTime; Windows PowerShell keeps strings.
function ConvertTo-Utc($value) {
  if ($value -is [DateTime]) { return $value.ToUniversalTime() }
  return [DateTime]::Parse([string]$value, [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
}

# A JSON array (or object) as a List, the same way in both PowerShell versions.
function Read-JsonList([string]$json) {
  $items = New-Object System.Collections.Generic.List[object]
  if ($json) { foreach ($item in ($json | ConvertFrom-Json)) { $items.Add($item) } }
  return , $items
}

# One GET. Returns the body on 2xx, else $null (the status and error body go to the summary).
function Invoke-OddsApi([string]$name, [string]$path, [hashtable]$query = @{}) {
  $pairs = @('apiKey=' + [uri]::EscapeDataString($key))
  foreach ($entry in $query.GetEnumerator()) {
    $pairs += $entry.Key + '=' + [uri]::EscapeDataString([string]$entry.Value)
  }
  $uri = $base + $path + '?' + ($pairs -join '&')
  $status = 0; $body = ''; $remaining = ''; $used = ''; $last = ''
  try {
    $response = Invoke-WebRequest -Uri $uri -Method Get -UseBasicParsing -TimeoutSec 30
    $status = [int]$response.StatusCode
    $body = $response.Content
    $remaining = $response.Headers['x-requests-remaining'] -join ''
    $used = $response.Headers['x-requests-used'] -join ''
    $last = $response.Headers['x-requests-last'] -join ''
  } catch {
    $failed = $_.Exception.Response
    if ($null -ne $failed) { $status = [int]$failed.StatusCode }
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
      $body = $_.ErrorDetails.Message
    } elseif ($failed -is [System.Net.HttpWebResponse]) {
      $reader = New-Object System.IO.StreamReader($failed.GetResponseStream())
      $body = $reader.ReadToEnd()
    } else {
      $body = $_.Exception.Message
    }
  }
  $body = ([string]$body).Replace($key, '***')
  [IO.File]::WriteAllText((Join-Path $outDir "$name.json"), $body)
  Add-Line "### $name  path=$path  status=$status  remaining=$remaining  used=$used  last=$last"
  if ($status -ge 200 -and $status -lt 300) { return $body }
  Add-Line "error body: $body"
  return $null
}

# An event with only its first $books bookmakers (keeps the summary small).
function Select-Books($item, [int]$books) {
  $copy = $item.PSObject.Copy()
  if ($null -ne $copy.bookmakers) { $copy.bookmakers = @($copy.bookmakers | Select-Object -First $books) }
  return $copy
}

# Featured odds of a sport: every bookmaker seen, one started event (if any) and upcoming ones.
function Show-Odds([string]$name, [string]$sportKey, [string]$markets, [int]$eventsToShow, [int]$books) {
  $events = Read-JsonList (Invoke-OddsApi $name "/sports/$sportKey/odds" @{
      regions = 'eu'; markets = $markets; oddsFormat = 'decimal'; dateFormat = 'iso' })
  $bookTitles = @{}
  foreach ($ev in $events) { foreach ($b in $ev.bookmakers) { $bookTitles[$b.key] = $b.title } }
  Add-Line ("events={0}" -f $events.Count)
  Add-Line ('bookmakers: ' + (($bookTitles.GetEnumerator() | Sort-Object Name |
        ForEach-Object { $_.Name + '=' + $_.Value }) -join ', '))
  $now = [DateTime]::UtcNow
  $picked = New-Object System.Collections.Generic.List[object]
  $started = $events | Where-Object { (ConvertTo-Utc $_.commence_time) -lt $now } | Select-Object -First 1
  if ($started) { $picked.Add($started) }
  foreach ($ev in ($events | Where-Object { (ConvertTo-Utc $_.commence_time) -ge $now } |
      Sort-Object { ConvertTo-Utc $_.commence_time })) {
    if ($picked.Count -ge $eventsToShow) { break }
    $picked.Add($ev)
  }
  foreach ($ev in $picked) { Add-Line (ConvertTo-Compact (Select-Books $ev $books)) }
  return , $events
}

# Scores: a few completed, in-play and upcoming entries.
function Show-Scores([string]$name, [string]$sportKey, [int]$daysFrom) {
  $scores = Read-JsonList (Invoke-OddsApi $name "/sports/$sportKey/scores" @{
      daysFrom = "$daysFrom"; dateFormat = 'iso' })
  $done = @($scores | Where-Object { $_.completed })
  $inPlay = @($scores | Where-Object { -not $_.completed -and $_.scores })
  $upcoming = @($scores | Where-Object { -not $_.completed -and -not $_.scores })
  Add-Line ("completed={0} in_play={1} upcoming={2}" -f $done.Count, $inPlay.Count, $upcoming.Count)
  $sample = @($done | Select-Object -First 3) + @($inPlay | Select-Object -First 2) +
    @($upcoming | Select-Object -First 1)
  foreach ($s in $sample) { Add-Line (ConvertTo-Compact $s) }
}

# 1. Every sport key, active or not (free).
$sports = Read-JsonList (Invoke-OddsApi 'sports' '/sports' @{ all = 'true' })
Add-Line ("sports={0}  (group | key | title | description | active | outrights)" -f $sports.Count)
foreach ($s in ($sports | Sort-Object group, key)) {
  Add-Line ("{0} | {1} | {2} | {3} | {4} | {5}" -f $s.group, $s.key, $s.title, $s.description,
    $s.active, $s.has_outrights)
}
$tennisKey = ($sports | Where-Object { $_.active -and $_.key -like 'tennis_*' -and $_.key -notlike '*_winner' } |
    Select-Object -First 1).key

# 2. Upcoming events without odds (free).
$eplEvents = Read-JsonList (Invoke-OddsApi 'epl-events' '/sports/soccer_epl/events' @{ dateFormat = 'iso' })
Add-Line ("events={0}" -f $eplEvents.Count)
foreach ($ev in ($eplEvents | Select-Object -First 2)) { Add-Line (ConvertTo-Compact $ev) }

# 3. Featured odds (cost: markets x regions each).
$epl = Show-Odds 'epl-odds' 'soccer_epl' 'h2h,totals' 2 8
$null = Show-Odds 'ucl-odds' 'soccer_uefa_champs_league' 'h2h,totals,spreads' 2 6
$null = Show-Odds 'nba-odds' 'basketball_nba' 'h2h,totals,spreads' 2 6
if ($tennisKey) { $null = Show-Odds 'tennis-odds' $tennisKey 'h2h,totals,spreads' 2 6 }
else { Add-Line '### tennis: no active tennis key' }

# 4. Scores (cost 2 each with daysFrom).
Show-Scores 'epl-scores' 'soccer_epl' 3
Show-Scores 'ucl-scores' 'soccer_uefa_champs_league' 1
Show-Scores 'nba-scores' 'basketball_nba' 1
if ($tennisKey) { Show-Scores 'tennis-scores' $tennisKey 3 }

# 5. One EPL event: the markets each bookmaker offers (cost 1) and extra markets (cost per market returned).
$next = $epl | Where-Object { (ConvertTo-Utc $_.commence_time) -gt [DateTime]::UtcNow } |
  Sort-Object { ConvertTo-Utc $_.commence_time } | Select-Object -First 1
if ($next) {
  $offered = Read-JsonList (Invoke-OddsApi 'epl-event-markets' "/sports/soccer_epl/events/$($next.id)/markets" @{
      regions = 'eu'; dateFormat = 'iso' })
  foreach ($e in $offered) {
    foreach ($b in ($e.bookmakers | Select-Object -First 10)) {
      Add-Line ($b.key + ': ' + (($b.markets | ForEach-Object { $_.key }) -join ','))
    }
  }
  $extra = Read-JsonList (Invoke-OddsApi 'epl-event-odds' "/sports/soccer_epl/events/$($next.id)/odds" @{
      regions = 'eu'; oddsFormat = 'decimal'; dateFormat = 'iso'
      markets = 'btts,draw_no_bet,h2h_3_way,alternate_totals,h2h_h1,totals_h1,team_totals' })
  foreach ($e in $extra) { Add-Line (ConvertTo-Compact (Select-Books $e 4)) }
}

# 6. Team names (cost 1) and two expected errors (no cost).
$participants = Read-JsonList (Invoke-OddsApi 'epl-participants' '/sports/soccer_epl/participants')
Add-Line ('participants=' + $participants.Count + ' sample: ' +
  (ConvertTo-Compact @($participants | Select-Object -First 5)))
$null = Invoke-OddsApi 'error-invalid-market' '/sports/soccer_epl/odds' @{ regions = 'eu'; markets = 'btts' }
$null = Invoke-OddsApi 'error-unknown-sport' '/sports/soccer_not_a_league/odds' @{ regions = 'eu'; markets = 'h2h' }

$text = $summary -join [Environment]::NewLine
$file = Join-Path $outDir 'summary.txt'
[IO.File]::WriteAllText($file, $text)
$copied = 'Copy it from that file.'
try { Set-Clipboard -Value $text; $copied = 'It is on the clipboard.' } catch { }
Write-Host ("Summary: {0} characters in {1}. {2} Paste it into the chat (it contains no API key)." -f $text.Length, $file, $copied)
