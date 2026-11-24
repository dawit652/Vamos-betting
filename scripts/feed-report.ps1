# Feed and review-queue report from the production server, run from the owner's PC (PowerShell 7):
#
#   pwsh -File scripts\feed-report.ps1
#
# It sends scripts/feed-report.sh (next to this file) to the server over ssh; on the server itself
# run that file directly (its first lines say how).
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

$remote = Get-Content -Raw -Encoding utf8 (Join-Path $PSScriptRoot 'feed-report.sh')
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
