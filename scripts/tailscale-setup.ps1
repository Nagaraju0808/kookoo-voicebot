# Tailscale setup for the KooKoo RAG receptionist.
# Exposes the local voicebot (webhook /kookoo + websocket /ws) on the public internet
# via Tailscale Funnel, then writes the public URL into .env as PUBLIC_URL.

param(
  [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
$tsExe = 'C:\Program Files\Tailscale\tailscale.exe'
$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot '.env'

# 1. Install Tailscale if missing
if (-not (Test-Path $tsExe)) {
  Write-Host '[1/5] Tailscale not found - installing via winget...'
  winget install --id tailscale.tailscale --silent --accept-package-agreements --accept-source-agreements
  if (-not (Test-Path $tsExe)) { throw 'Tailscale install failed - install manually from https://tailscale.com/download' }
} else {
  Write-Host '[1/5] Tailscale already installed.'
}

# 2. Make sure the tailscaled service is running
$svc = Get-Service -Name 'Tailscale*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($svc -and $svc.Status -ne 'Running') {
  Write-Host '[2/5] Starting Tailscale service...'
  Start-Service $svc.Name
  Start-Sleep 3
} else {
  Write-Host '[2/5] Tailscale service running.'
}

# 3. Check login; if logged out, print the auth URL for the user
$status = & $tsExe status --json | ConvertFrom-Json
if ($status.BackendState -ne 'Running' -or -not $status.Self) {
  Write-Host '[3/5] Not logged in. Running `tailscale login` - open the URL it prints in a browser:'
  & $tsExe login
  $status = & $tsExe status --json | ConvertFrom-Json
  if (-not $status.Self) { throw 'Tailscale login did not complete.' }
}
$dnsName = ($status.Self.DNSName -replace '\.$', '')
Write-Host "[3/5] Logged in as $($status.Self.HostName) ($dnsName)"

# 4. Enable Funnel on the bot port (persistent background config)
Write-Host "[4/5] Enabling Funnel on port $Port..."
& $tsExe funnel --bg $Port
$funnelUrl = "https://$dnsName"

# 5. Write PUBLIC_URL into .env so the KooKoo webhook returns the funnel URL
if (Test-Path $envFile) {
  $lines = Get-Content $envFile
  $found = $false
  $lines = $lines | ForEach-Object {
    if ($_ -match '^\s*#?\s*PUBLIC_URL=') { $found = $true; "PUBLIC_URL=$funnelUrl" } else { $_ }
  }
  if (-not $found) { $lines += "PUBLIC_URL=$funnelUrl" }
  Set-Content -Path $envFile -Value $lines
  Write-Host "[5/5] .env updated: PUBLIC_URL=$funnelUrl"
} else {
  Write-Host "[5/5] .env not found - set PUBLIC_URL=$funnelUrl manually."
}

Write-Host ''
Write-Host 'Setup complete. Start the bot and point KooKoo at the funnel URL:'
Write-Host '  npm start'
Write-Host "  KooKoo Application URL: $funnelUrl/api/ivr/webhook"
Write-Host "  Health check:           $funnelUrl/health"
Write-Host 'To stop exposing publicly: tailscale funnel reset'
