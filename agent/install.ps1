<#
.SYNOPSIS
  One-command installer for the NDI P21 Bridge Agent (ndiOS-agent).

.DESCRIPTION
  Run this from the folder that contains ndiOS-agent.exe and env.example.txt
  (or .env.example). It will:

    1. Create the install folder (default C:\ndiOS-agent).
    2. Stop any agent that is already running (scheduled task or service).
    3. Copy ndiOS-agent.exe into place.
    4. Build .env from the example, prompting only for values that are missing.
       An existing .env is preserved: its values become the defaults and it is
       backed up before being rewritten.
    5. Register a boot-start scheduled task (default) or a Windows service.
    6. Smoke-test: start it, confirm it prints its version and job kinds.
    7. Report this machine's public egress IP so you can confirm the partner
       SFTP allow-list entry (expected 142.190.99.117).

  Must be run from an ELEVATED PowerShell prompt (Run as administrator).

.EXAMPLE
  # Typical install, all prompts interactive
  powershell -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
  # Non-interactive: pass the secrets in, install as a Windows service
  .\install.ps1 -BridgeSecret 'xxx' -SqlHost 'p21sql' -SqlUser 'p21_readonly' `
                -SqlPassword 'yyy' -AsService

.EXAMPLE
  # Re-run after dropping in a newer .exe; keep the existing .env untouched
  .\install.ps1 -KeepEnv
#>

[CmdletBinding()]
param(
  [string] $InstallDir = 'C:\ndiOS-agent',
  [string] $AgentName,
  [string] $BridgeSecret,
  [string] $SqlHost,
  [string] $SqlDatabase,
  [string] $SqlUser,
  [string] $SqlPassword,
  [string] $SftpPrivateKeyPath,
  [switch] $AsService,
  [switch] $KeepEnv,
  [switch] $SkipSmokeTest
)

$ErrorActionPreference = 'Stop'
$TaskName    = 'ndiOS Agent'
$ServiceName = 'NDI P21 Bridge Agent'
$SourceDir   = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }

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

$exeSource = Join-Path $SourceDir 'ndiOS-agent.exe'
if (-not (Test-Path $exeSource)) {
  Fail "ndiOS-agent.exe not found next to this script ($SourceDir). Put the .exe in the same folder and re-run."
}
Write-Ok "Found $exeSource ($([math]::Round((Get-Item $exeSource).Length / 1MB)) MB)"

# Optional checksum verification if a .sha256 sits alongside the exe.
$shaFile = Join-Path $SourceDir 'ndiOS-agent.exe.sha256'
if (Test-Path $shaFile) {
  $expected = ((Get-Content $shaFile -Raw) -split '\s+')[0].Trim().ToLower()
  $actual   = (Get-FileHash $exeSource -Algorithm SHA256).Hash.ToLower()
  if ($expected -and $expected -ne $actual) {
    Fail "Checksum mismatch. Expected $expected, got $actual. The .exe is corrupt or truncated — re-download it."
  }
  Write-Ok 'SHA-256 checksum matches'
}

$exampleSource = @('env.example.txt', '.env.example') |
  ForEach-Object { Join-Path $SourceDir $_ } |
  Where-Object   { Test-Path $_ } |
  Select-Object  -First 1
if (-not $exampleSource -and -not $KeepEnv) {
  Fail 'No env.example.txt / .env.example found next to this script, and -KeepEnv was not passed.'
}

# ------------------------------------------------------------ stop existing ---
Write-Step 'Stopping any agent already running'

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
  Write-Ok "Stopped scheduled task '$TaskName'"
}

$existingSvc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingSvc -and $existingSvc.Status -ne 'Stopped') {
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  Write-Ok "Stopped service '$ServiceName'"
}

# node-windows installs the service under a slug name too; catch that variant.
$slugSvc = Get-Service -Name 'ndip21bridgeagent*' -ErrorAction SilentlyContinue
foreach ($s in $slugSvc) {
  if ($s.Status -ne 'Stopped') {
    Stop-Service -Name $s.Name -Force -ErrorAction SilentlyContinue
    Write-Ok "Stopped service '$($s.Name)'"
  }
}

# Anything still holding the .exe open would block the copy.
Get-Process -Name 'ndiOS-agent' -ErrorAction SilentlyContinue | ForEach-Object {
  $_ | Stop-Process -Force
  Write-Ok "Killed lingering process PID $($_.Id)"
}
Start-Sleep -Seconds 2

# -------------------------------------------------------------- copy binary ---
Write-Step "Installing to $InstallDir"

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$exeTarget = Join-Path $InstallDir 'ndiOS-agent.exe'
if (Test-Path $exeTarget) {
  Copy-Item $exeTarget "$exeTarget.bak" -Force
  Write-Ok 'Backed up previous .exe to ndiOS-agent.exe.bak'
}
Copy-Item $exeSource $exeTarget -Force
Write-Ok 'Copied ndiOS-agent.exe'

$keysDir = Join-Path $InstallDir 'keys'
New-Item -ItemType Directory -Path $keysDir -Force | Out-Null

# ------------------------------------------------------------------- .env -----
$envTarget = Join-Path $InstallDir '.env'

if ($KeepEnv -and (Test-Path $envTarget)) {
  Write-Step 'Keeping existing .env (-KeepEnv)'
} else {
  Write-Step 'Building .env'

  # Parse the example into an ordered list of lines, and the current .env (if
  # any) into a lookup that supplies defaults.
  $exampleLines = Get-Content $exampleSource
  $current = @{}
  if (Test-Path $envTarget) {
    foreach ($line in Get-Content $envTarget) {
      if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') {
        $current[$Matches[1]] = $Matches[2].Trim()
      }
    }
    Copy-Item $envTarget "$envTarget.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" -Force
    Write-Ok 'Existing .env backed up; its values are the defaults below'
  }

  # Values supplied on the command line win over everything.
  $overrides = @{}
  if ($AgentName)          { $overrides['AGENT_NAME']            = $AgentName }
  if ($BridgeSecret)       { $overrides['BRIDGE_SECRET']         = $BridgeSecret }
  if ($SqlHost)            { $overrides['P21_SQL_HOST']          = $SqlHost }
  if ($SqlDatabase)        { $overrides['P21_SQL_DB']            = $SqlDatabase }
  if ($SqlUser)            { $overrides['P21_SQL_USER']          = $SqlUser }
  if ($SqlPassword)        { $overrides['P21_SQL_PASS']          = $SqlPassword }
  if ($SftpPrivateKeyPath) { $overrides['SFTP_PRIVATE_KEY_PATH'] = $SftpPrivateKeyPath }

  # Keys we must not leave blank — prompt until we get something.
  $required = @(
    'BRIDGE_SECRET', 'P21_SQL_HOST', 'P21_SQL_DB', 'P21_SQL_USER', 'P21_SQL_PASS',
    'SFTP_PRIVATE_KEY_PATH'
  )
  # Keys that are fine to leave empty (P21 REST API, SFTP passphrase, etc).
  $optionalBlank = @(
    'P21_API_CONSUMER_KEY', 'P21_API_USERNAME', 'P21_API_PASSWORD',
    'SFTP_PRIVATE_KEY_PASSPHRASE'
  )
  $secretKeys = @('BRIDGE_SECRET', 'P21_SQL_PASS', 'P21_API_PASSWORD',
                  'P21_API_CONSUMER_KEY', 'SFTP_PRIVATE_KEY_PASSPHRASE')

  Write-Host '    Press Enter to accept the value shown in [brackets].' -ForegroundColor DarkGray

  $out = New-Object System.Collections.Generic.List[string]
  foreach ($line in $exampleLines) {
    if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') {
      $out.Add($line)   # comment or blank — keep verbatim
      continue
    }
    $key      = $Matches[1]
    $fallback = $Matches[2].Trim()
    $default  = if ($overrides.ContainsKey($key)) { $overrides[$key] }
                elseif ($current.ContainsKey($key) -and $current[$key]) { $current[$key] }
                else { $fallback }

    $value = $default
    $needsPrompt = ($required -contains $key -and [string]::IsNullOrWhiteSpace($value)) `
                   -or ($overrides.ContainsKey($key) -eq $false `
                        -and $required -contains $key `
                        -and -not $current.ContainsKey($key))

    if ($needsPrompt) {
      while ($true) {
        $shown = if ($secretKeys -contains $key -and $value) { '<kept>' } else { $value }
        $answer = if ($shown) { Read-Host "    $key [$shown]" } else { Read-Host "    $key" }
        if ($answer) { $value = $answer.Trim(); break }
        if ($value)  { break }
        if ($optionalBlank -contains $key) { break }
        Write-Warn2 "$key is required."
      }
    }

    $out.Add("$key=$value")
  }

  # UTF-8 without BOM — dotenv chokes on a BOM in front of the first key.
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($envTarget, ($out -join "`r`n") + "`r`n", $utf8NoBom)
  Write-Ok ".env written to $envTarget"

  # Lock it down: SYSTEM + Administrators only. It holds the bridge secret.
  try {
    icacls $envTarget /inheritance:r /grant 'SYSTEM:(R)' 'Administrators:(F)' | Out-Null
    Write-Ok '.env permissions restricted to SYSTEM + Administrators'
  } catch { Write-Warn2 "Could not tighten .env ACL: $($_.Exception.Message)" }

  # Warn (don't fail) if the SSH key isn't in place yet.
  $keyPath = ($out | Where-Object { $_ -like 'SFTP_PRIVATE_KEY_PATH=*' } |
              Select-Object -First 1) -replace '^SFTP_PRIVATE_KEY_PATH=', ''
  if ($keyPath -and -not (Test-Path $keyPath)) {
    Write-Warn2 "SSH private key not found at $keyPath — copy the NDI-Charlston-Automation key there before the first live SFTP run."
  } elseif ($keyPath) {
    Write-Ok "SSH private key present at $keyPath"
    try { icacls $keyPath /inheritance:r /grant 'SYSTEM:(R)' 'Administrators:(F)' | Out-Null } catch {}
  }
}

# --------------------------------------------------------------- smoke test ---
if (-not $SkipSmokeTest) {
  Write-Step 'Smoke test (12 seconds)'
  $logPath = Join-Path $InstallDir 'install-smoketest.log'
  $proc = Start-Process -FilePath $exeTarget -WorkingDirectory $InstallDir `
            -RedirectStandardOutput $logPath -RedirectStandardError "$logPath.err" `
            -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 12
  if (-not $proc.HasExited) { $proc | Stop-Process -Force }

  $log = ''
  foreach ($p in @($logPath, "$logPath.err")) {
    if (Test-Path $p) { $log += (Get-Content $p -Raw) }
  }
  if ($log -match 'v(\d+\.\d+\.\d+)') { Write-Ok "Agent reported version $($Matches[1])" }
  if ($log -match 'website\.export\.sftp') { Write-Ok 'website.export.sftp handler present' }
  else { Write-Warn2 'website.export.sftp not listed — this .exe is older than v1.2.0.' }
  if ($log -match 'Missing BRIDGE_URL|bad signature|stale signature') {
    Write-Warn2 'Bridge auth problem in the log — check BRIDGE_SECRET and the system clock.'
  }
  if ($log -match 'Login failed|ETIMEDOUT') {
    Write-Warn2 'SQL connection problem — confirm FortiClient is connected and the SQL creds are right.'
  }
  Write-Host "    Full log: $logPath" -ForegroundColor DarkGray
}

# ----------------------------------------------------------------- register ---
if ($AsService) {
  Write-Step "Registering Windows service '$ServiceName'"
  if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    sc.exe delete "$ServiceName" | Out-Null
    Start-Sleep -Seconds 2
  }
  sc.exe create "$ServiceName" binPath= "`"$exeTarget`"" start= auto DisplayName= "$ServiceName" | Out-Null
  sc.exe description "$ServiceName" "Runs P21 SQL and SFTP export jobs for NDI Ops Hub over the FortiClient VPN." | Out-Null
  # Restart on crash: 1st/2nd/subsequent failures after 60s, reset counter daily.
  sc.exe failure "$ServiceName" reset= 86400 actions= restart/60000/restart/60000/restart/60000 | Out-Null
  Start-Service -Name $ServiceName
  Start-Sleep -Seconds 3
  $svc = Get-Service -Name $ServiceName
  if ($svc.Status -eq 'Running') { Write-Ok "Service running (startup: Automatic)" }
  else { Write-Warn2 "Service status is $($svc.Status) — check Event Viewer." }
} else {
  Write-Step "Registering scheduled task '$TaskName'"
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
}

# --------------------------------------------------------------- egress IP ----
Write-Step 'Confirming public egress IP for the partner SFTP allow-list'
try {
  $ip = (Invoke-RestMethod -Uri 'https://api.ipify.org?format=json' -TimeoutSec 15).ip
  if ($ip -eq '142.190.99.117') { Write-Ok "Egress IP is $ip — matches the allow-listed address" }
  else { Write-Warn2 "Egress IP is $ip but the partner allow-listed 142.190.99.117. SFTP uploads will be refused until this is reconciled." }
} catch {
  Write-Warn2 "Could not determine egress IP: $($_.Exception.Message)"
}

# ------------------------------------------------------------------- done -----
Write-Host "`nDone." -ForegroundColor Green
Write-Host @"

Next steps
  1. Open NDI Ops Hub -> Settings -> Integrations -> P21 Bridge. The agent should
     show online (green) within ~5 seconds, reporting v1.2.0.
  2. Go to Insights -> Website Export and click "Dry run". It runs the stored
     procedure and returns row count, byte size and a 3-row preview WITHOUT
     uploading anything.
  3. If the dry run looks right, click "Run now" for one live upload, verify the
     file landed in Charlston_OF, then enable the nightly schedule.

Useful commands
  Status:    $(if ($AsService) { "sc query `"$ServiceName`"" } else { "Get-ScheduledTaskInfo -TaskName '$TaskName'" })
  Restart:   $(if ($AsService) { "Restart-Service '$ServiceName'" } else { "Stop-ScheduledTask -TaskName '$TaskName'; Start-ScheduledTask -TaskName '$TaskName'" })
  Uninstall: $(if ($AsService) { "sc stop `"$ServiceName`"; sc delete `"$ServiceName`"" } else { "Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false" })
  Edit env:  notepad $envTarget   (restart the agent after editing)

"@ -ForegroundColor Gray
