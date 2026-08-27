<#
.SYNOPSIS
  Phase 0 / A2 — the ONLY three probes permitted against the PRODUCTION relay.

.DESCRIPTION
  Read-only by construction:
    1. GET /healthz            -> expect HTTP 200
    2. GET /readyz             -> expect HTTP 200
    3. scripts/smoke-cloud-run.py against wss://.../v1/product-route
       -> expect "HTTP/1.1 101" upgrade. The smoke script sends NO hello:
       no route, no nonce, no admission — pure TLS/WebSocket upgrade.
  ANYTHING else against production is forbidden; stateful checks run against
  a local packet-relay.exe only.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File 01-relay-readonly-probe.ps1
#>
[CmdletBinding()]
param(
  [string]$RelayHost   = 'packet-relay-1038865114903.us-central1.run.app',
  [string]$SmokeScript = 'D:\projects\packetrelay\scripts\smoke-cloud-run.py',
  [string]$Python      = 'python'
)

$ErrorActionPreference = 'Stop'
$fail = $false

foreach ($path in '/healthz', '/readyz') {
  $url = "https://$RelayHost$path"
  try {
    # -UseBasicParsing for Windows PowerShell 5.1 compatibility; non-2xx is
    # caught below and its status code extracted, so this works on 5.1 and 7+.
    try {
      $resp = Invoke-WebRequest -Uri $url -Method Get -TimeoutSec 15 -UseBasicParsing
    } catch {
      $resp = $_.Exception.Response
      if ($null -eq $resp) { throw }
    }
    $code = [int]$resp.StatusCode
    $body = if ($resp.PSObject.Properties['Content']) { ([string]$resp.Content).Trim() } else { '' }
    if ($body.Length -gt 200) { $body = $body.Substring(0, 200) + '...' }
    if ($code -eq 200) {
      Write-Host ("PASS: GET {0} -> {1}  body: {2}" -f $url, $code, $body) -ForegroundColor Green
    } else {
      Write-Host ("FAIL: GET {0} -> {1}  body: {2}" -f $url, $code, $body) -ForegroundColor Red
      $fail = $true
    }
  } catch {
    Write-Host ("FAIL: GET {0} -> {1}" -f $url, $_.Exception.Message) -ForegroundColor Red
    $fail = $true
  }
}

if (-not (Test-Path -LiteralPath $SmokeScript)) {
  Write-Host "FAIL: smoke script not found: $SmokeScript" -ForegroundColor Red
  exit 1
}
$wss = "wss://$RelayHost/v1/product-route"
Write-Host "Running (no hello is sent): $Python $SmokeScript $wss"
& $Python $SmokeScript $wss
if ($LASTEXITCODE -eq 0) {
  Write-Host "PASS: WSS upgrade smoke (HTTP/1.1 101) at $wss" -ForegroundColor Green
} else {
  Write-Host "FAIL: smoke-cloud-run.py exited $LASTEXITCODE" -ForegroundColor Red
  $fail = $true
}

if ($fail) { exit 1 }
Write-Host ''
Write-Host 'PASS: all three permitted production probes succeeded (200 / 200 / 101).' -ForegroundColor Green
exit 0
