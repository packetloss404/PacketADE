<#
.SYNOPSIS
  Phase 0 / A1 — SHA-256 parity across the three controller-relay-crypto-v1
  fixture copies (PacketADE, Syndicate docs, PacketRelay testdata).

.DESCRIPTION
  Read-only. PASS = all three SHA-256 hashes identical.
  Known gap (always printed): this fixture pins the controller->Host crypto
  vectors only — it pins NEITHER the device_hello vectors NOR the grant
  liveness literals (30-day lifetime, 7-day warning). Parity here proves
  shared crypto vectors, not liveness behaviour.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File 00-fixture-parity.ps1
#>
[CmdletBinding()]
param(
  [string]$PacketAdeFixture  = 'D:\projects\PacketADE\src-tauri\tests\fixtures\controller-relay-crypto-v1.json',
  [string]$SyndicateFixture  = 'D:\projects\syndicate\docs\fixtures\controller-relay-crypto-v1.json',
  [string]$PacketRelayFixture = 'D:\projects\packetrelay\testdata\controller_relay_crypto_v1.json'
)

$ErrorActionPreference = 'Stop'
$fixtures = [ordered]@{
  'PacketADE '  = $PacketAdeFixture
  'Syndicate '  = $SyndicateFixture
  'PacketRelay' = $PacketRelayFixture
}

$hashes = @()
foreach ($entry in $fixtures.GetEnumerator()) {
  if (-not (Test-Path -LiteralPath $entry.Value)) {
    Write-Host "FAIL: missing fixture: $($entry.Value)" -ForegroundColor Red
    exit 1
  }
  $h = Get-FileHash -LiteralPath $entry.Value -Algorithm SHA256
  $len = (Get-Item -LiteralPath $entry.Value).Length
  Write-Host ("{0}  {1}  ({2} bytes)  {3}" -f $entry.Key, $h.Hash, $len, $entry.Value)
  $hashes += $h.Hash
}

$distinct = @($hashes | Select-Object -Unique)
Write-Host ''
if ($distinct.Count -eq 1) {
  Write-Host "PASS: all three fixture copies share SHA-256 $($distinct[0])" -ForegroundColor Green
  $exit = 0
} else {
  Write-Host "FAIL: fixture copies have diverged ($($distinct.Count) distinct hashes)" -ForegroundColor Red
  $exit = 1
}

Write-Host ''
Write-Host 'NOTE (known gap): this fixture pins the controller->Host crypto vectors only.'
Write-Host 'It pins NEITHER the device_hello vectors NOR the grant-liveness literals'
Write-Host '(30-day grant lifetime, 7-day warning window). Parity proves shared crypto'
Write-Host 'vectors, not liveness behaviour.'
exit $exit
