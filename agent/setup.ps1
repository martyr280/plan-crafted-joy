<#
.SYNOPSIS
  One-shot setup for the NDI P21 Bridge Agent v1.2.0 SFTP export.
  For Kevin @ NDI — run once, as administrator, no prompts.

.DESCRIPTION
  Assumes the new agent files have already been downloaded to
  C:\ndiOS-agent\newagent (ndiOS-agent.exe, optionally its .sha256) and that
  the v1.x agent is already installed at C:\ndiOS-agent with a working .env.

  What it does, in order:
    1. Verifies the staged ndiOS-agent.exe (checksum if a .sha256 is present).
    2. Generates the NDI-Charlston-Automation SSH key pair at
       C:\ndiOS-agent\keys\ if it doesn't exist yet. The PRIVATE key never
       leaves this server. The PUBLIC key (.pub) is printed at the end and
       copied to the clipboard — that's the only thing to send back.
    3. Adds the SFTP settings to the existing .env (backs it up first;
       existing values are never overwritten).
    4. Stops the running agent, backs up the old .exe, swaps in the new one.
    5. Smoke-tests: the agent must report v1.2.0 and list website.export.sftp.
    6. Re-registers the boot-start scheduled task and starts the agent.
    7. Confirms this machine's public egress IP (expected 142.190.99.117).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\setup.ps1
#>

[CmdletBinding()]
param(
  [string] $InstallDir = 'C:\ndiOS-agent',
  [string] $StagedDir  = 'C:\ndiOS-agent\newagent',
  [string] $KeyName    = 'NDI-Charlston-Automation',
  [string] $ExpectedIp = '142.190.99.117',
  [switch] $SkipSmokeTest
)

$ErrorActionPreference = 'Stop'
$TaskName    = 'ndiOS Agent'
$ServiceName = 'NDI P21 Bridge Agent'
$KeyDir      = Join-Path $InstallDir 'keys'
$KeyPath     = Join-Path $KeyDir $KeyName
$PubPath     = "$KeyPath.pub"

function Write-Step  ($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-Ok    ($m) { Write-Host "    [ok] $m" -ForegroundColor Green }
function Write-Warn2 ($m) { Write-Host "    [!]  $m" -ForegroundColor Yellow }
function Fail        ($m) { Write-Host "`nFAILED: $m" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- preflight ---
Write-Step 'Preflight'

$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Fail 'Not elevated. Right-click PowerShell -> Run as administrator, then re-run this script.'
}
Write-Ok 'Running elevated'

$exeSource = Join-Path $StagedDir 'ndiOS-agent.exe'
if (-not (Test-Path $exeSource)) {
  Fail "New agent not found at $exeSource. Put ndiOS-agent.exe in $StagedDir and re-run."
}
Write-Ok "Found staged agent: $exeSource ($([math]::Round((Get-Item $exeSource).Length / 1MB)) MB)"

$shaFile = Join-Path $StagedDir 'ndiOS-agent.exe.sha256'
if (Test-Path $shaFile) {
  $expected = ((Get-Content $shaFile -Raw) -split '\s+')[0].Trim().ToLower()
  $actual   = (Get-FileHash $exeSource -Algorithm SHA256).Hash.ToLower()
  if ($expected -and $expected -ne $actual) {
    Fail "Checksum mismatch. Expected $expected, got $actual. The staged .exe is corrupt or truncated — re-download it."
  }
  Write-Ok 'SHA-256 checksum matches'
} else {
  Write-Warn2 'No .sha256 file next to the staged .exe — skipping checksum verification.'
}

$envTarget = Join-Path $InstallDir '.env'
if (-not (Test-Path $envTarget)) {
  Fail "$envTarget not found. This script expects the agent to already be installed with a working .env (bridge secret + SQL creds). Contact Marty if it's missing."
}
Write-Ok "Found existing .env"

# ------------------------------------------------------------- SSH key pair ---
Write-Step "SSH key pair ($KeyName)"

New-Item -ItemType Directory -Path $KeyDir -Force | Out-Null

if (Test-Path $KeyPath) {
  Write-Ok "Private key already exists at $KeyPath — keeping it"
  if (-not (Test-Path $PubPath)) {
    Write-Warn2 "But the .pub file is missing. Regenerating it from the private key:"
    ssh-keygen -y -f $KeyPath | Set-Content -Path $PubPath -Encoding ascii
  }
} else {
  if (-not (Get-Command ssh-keygen -ErrorAction SilentlyContinue)) {
    Write-Warn2 'ssh-keygen not found. Installing the Windows OpenSSH client feature...'
    try {
      Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0 | Out-Null
    } catch {
      Fail "Could not install OpenSSH client automatically: $($_.Exception.Message). Install it via Settings -> Optional Features -> OpenSSH Client, then re-run."
    }
  }
  # Empty-passphrase quoting differs between Windows PowerShell 5.1 and PS 7+.
  $noPass = if ($PSVersionTable.PSVersion.Major -ge 7) { '' } else { '""' }
  ssh-keygen -t rsa -b 4096 -f $KeyPath -N $noPass -C $KeyName | Out-Null
  if (-not (Test-Path $KeyPath) -or -not (Test-Path $PubPath)) {
    Fail 'ssh-keygen did not produce the key pair. Run it manually and re-run this script.'
  }
  Write-Ok "Generated key pair at $KeyPath"
}

# Lock the private key down to SYSTEM + Administrators.
try {
  icacls $KeyPath /inheritance:r /grant 'SYSTEM:(R)' 'Administrators:(F)' | Out-Null
  Write-Ok 'Private key ACL restricted to SYSTEM + Administrators'
} catch { Write-Warn2 "Could not tighten key ACL: $($_.Exception.Message)" }

# -------------------------------------------------------------- patch .env ----
Write-Step 'Adding SFTP settings to .env (existing values are kept)'

Copy-Item $envTarget "$envTarget.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" -Force
Write-Ok 'Backed up current .env'

$sftpDefaults = [ordered]@{
  'SFTP_HOST'                     = 'ssh.ndiofficefurniture.net'
  'SFTP_PORT'                     = '18765'
  'SFTP_USERNAME'                 = 'u2323-uw7q3pmmnio7'
  'SFTP_PRIVATE_KEY_PATH'         = $KeyPath
  'SFTP_PRIVATE_KEY_PASSPHRASE'   = ''
  'WEBSITE_EXPORT_SQL_TIMEOUT_MS' = '600000'
}
# Keys that are allowed to stay empty.
$blankOk = @('SFTP_PRIVATE_KEY_PASSPHRASE')

$lines = [System.Collections.Generic.List[string]]@(Get-Content $envTarget)
$present = @{}
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') {
    $present[$Matches[1]] = @{ index = $i; value = $Matches[2].Trim() }
  }
}

$appended = $false
foreach ($key in $sftpDefaults.Keys) {
  $want = $sftpDefaults[$key]
  if ($present.ContainsKey($key)) {
    $cur = $present[$key].value
    if ([string]::IsNullOrWhiteSpace($cur) -and -not ($blankOk -contains $key)) {
      $lines[$present[$key].index] = "$key=$want"
      Write-Ok "$key was empty — set to $want"
    } else {
      Write-Ok "$key already set — keeping existing value"
    }
  } else {
    if (-not $appended) {
      $lines.Add('')
      $lines.Add('# --- Partner SFTP delivery (Charlston Office Furniture website export) ---')
      $appended = $true
    }
    $lines.Add("$key=$want")
    Write-Ok "$key added"
  }
}

# UTF-8 without BOM — dotenv chokes on a BOM in front of the first key.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($envTarget, (($lines -join "`r`n").TrimEnd("`r", "`n")) + "`r`n", $utf8NoBom)
Write-Ok '.env updated'

try { icacls $envTarget /inheritance:r /grant 'SYSTEM:(R)' 'Administrators:(F)' | Out-Null } catch {}

# ----------------------------------------------------------- stop old agent ---
Write-Step 'Stopping the running agent'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
  Write-Ok "Stopped scheduled task '$TaskName'"
}
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -ne 'Stopped') {
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  Write-Ok "Stopped service '$ServiceName'"
}
foreach ($s in (Get-Service -Name 'ndip21bridgeagent*' -ErrorAction SilentlyContinue)) {
  if ($s.Status -ne 'Stopped') { Stop-Service -Name $s.Name -Force -ErrorAction SilentlyContinue }
}
Get-Process -Name 'ndiOS-agent' -ErrorAction SilentlyContinue | ForEach-Object {
  $_ | Stop-Process -Force
  Write-Ok "Killed lingering process PID $($_.Id)"
}
Start-Sleep -Seconds 2

# ------------------------------------------------------------ swap in v1.2.0 --
Write-Step 'Installing the new agent'

$exeTarget = Join-Path $InstallDir 'ndiOS-agent.exe'
if (Test-Path $exeTarget) {
  Copy-Item $exeTarget "$exeTarget.bak" -Force
  Write-Ok 'Backed up previous .exe to ndiOS-agent.exe.bak'
}
Copy-Item $exeSource $exeTarget -Force
Write-Ok 'Copied new ndiOS-agent.exe into place'

# --------------------------------------------------------------- smoke test ---
if (-not $SkipSmokeTest) {
  Write-Step 'Smoke test (12 seconds)'
  $logPath = Join-Path $InstallDir 'setup-smoketest.log'
  $proc = Start-Process -FilePath $exeTarget -WorkingDirectory $InstallDir `
            -RedirectStandardOutput $logPath -RedirectStandardError "$logPath.err" `
            -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 12
  if (-not $proc.HasExited) { $proc | Stop-Process -Force }

  $log = ''
  foreach ($p in @($logPath, "$logPath.err")) {
    if (Test-Path $p) { $log += (Get-Content $p -Raw) }
  }
  if ($log -match 'v1\.2\.\d+') { Write-Ok "Agent reported $($Matches[0])" }
  else { Write-Warn2 'Agent did not report v1.2.x — check the log.' }
  if ($log -match 'website\.export\.sftp') { Write-Ok 'website.export.sftp handler present' }
  else { Write-Warn2 'website.export.sftp not listed — the staged .exe is older than v1.2.0.' }
  if ($log -match 'Missing BRIDGE_URL|bad signature|stale signature') {
    Write-Warn2 'Bridge auth problem — check BRIDGE_SECRET in .env and the system clock.'
  }
  if ($log -match 'Login failed|ETIMEDOUT') {
    Write-Warn2 'SQL connection problem — confirm FortiClient is connected.'
  }
  Write-Host "    Full log: $logPath" -ForegroundColor DarkGray
}

# ------------------------------------------------------------ register task ---
Write-Step "Registering boot-start scheduled task '$TaskName'"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
$action    = New-ScheduledTaskAction -Execute $exeTarget -WorkingDirectory $InstallDir
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -RestartCount 999 `
               -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable `
               -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
               -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description 'NDI P21 Bridge Agent — polls NDI Ops Hub for P21 SQL and SFTP export jobs.' | Out-Null
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 5
$info = Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo
Write-Ok "Task registered and started (last result: $($info.LastTaskResult))"

# --------------------------------------------------------------- egress IP ----
Write-Step 'Confirming public egress IP for the SFTP allow-list'
try {
  $ip = (Invoke-RestMethod -Uri 'https://api.ipify.org?format=json' -TimeoutSec 15).ip
  if ($ip -eq $ExpectedIp) { Write-Ok "Egress IP is $ip — matches the allow-listed address" }
  else { Write-Warn2 "Egress IP is $ip but the allow-list expects $ExpectedIp. SFTP uploads will be refused until this is reconciled." }
} catch {
  Write-Warn2 "Could not determine egress IP: $($_.Exception.Message)"
}

# ------------------------------------------------------------------- done -----
$pubText = (Get-Content $PubPath -Raw).Trim()
try { Set-Clipboard -Value $pubText; $clipNote = ' (also copied to your clipboard)' } catch { $clipNote = '' }

Write-Host "`nDone." -ForegroundColor Green
Write-Host @"

ONE THING TO SEND BACK$clipNote
  This is the PUBLIC key to import for SFTP user u2323-uw7q3pmmnio7
  (file: $PubPath):

"@ -ForegroundColor Gray
Write-Host $pubText -ForegroundColor White
Write-Host @"

  Paste it in a reply to Marty, or import it directly if you manage the
  SFTP account. The private key stays on this server — never send it.

Next steps
  1. The agent should show online (green, v1.2.0) in Nelson under
     Settings -> Integrations -> P21 Bridge within ~5 seconds.
  2. Once the public key is imported and the allow-list is live, Marty runs
     a dry run from Nelson (Insights -> Website Export), then one live
     upload to verify the file lands in Charlston_OF, then enables nightly.

Useful commands
  Status:    Get-ScheduledTaskInfo -TaskName '$TaskName'
  Restart:   Stop-ScheduledTask -TaskName '$TaskName'; Start-ScheduledTask -TaskName '$TaskName'
  Rollback:  stop the task, restore ndiOS-agent.exe.bak and the .env backup in $InstallDir, start the task

"@ -ForegroundColor Gray
