# Order Mail parity harness for Email Archiver v4.5.3.
# Runs the DESKTOP engine (archiver-lib.ps1) on the fixture knowledge and writes
# the expected decisions the TypeScript port must reproduce.
#
#   pwsh -NoProfile -File scripts/archiver-parity-v453.ps1 `
#     -Lib <path to archiver-lib.ps1 v4.5.3> `
#     -Fixtures src/lib/archiver/__tests__/fixtures/v453 `
#     -V452 src/lib/archiver/__tests__/fixtures/v452
#
# Output: <Fixtures>/golden.json (do not edit by hand).
param(
  [Parameter(Mandatory = $true)][string]$Lib,
  [Parameter(Mandatory = $true)][string]$Fixtures,
  [Parameter(Mandatory = $true)][string]$V452
)
$ErrorActionPreference = 'Stop'
. $Lib

function Read-Json([string]$p) { [IO.File]::ReadAllText($p) | ConvertFrom-Json }

function Get-Knowledge([string]$dir, $extras) {
  $k = @{
    mapping  = @(Load-Mapping (Join-Path $dir 'customer-mapping.csv'))
    learned  = Load-Learned (Join-Path $dir 'learned-routing.json')
    ctx      = Load-ContextRules (Join-Path $dir 'context-rules.json')
    internal = Load-InternalRoutes (Join-Path $dir 'internal-routes.json')
    multi    = Load-MultiRoutes (Join-Path $dir 'multi-routes.json')
  }
  if ($extras) {
    foreach ($p in $extras.learnedDomains.PSObject.Properties) {
      $v = $p.Value
      $k.learned.domains[$p.Name] = @{ customer = "$($v.customer)"; count = [int]$v.count; source = "$($v.source)"
        first = (ConvertTo-IsoStamp $v.first); last = (ConvertTo-IsoStamp $v.last); root = ''; run = '' }
    }
    $list = New-Object System.Collections.Generic.List[object]
    foreach ($r in @($k.ctx.rules)) { $list.Add($r) }
    foreach ($r in @($extras.contextRules)) {
      $list.Add(@{ id = "$($r.id)"; phrase = "$($r.phrase)"; customer = "$($r.customer)"; scope = "$($r.scope)"; match = "$($r.match)"
        weight = [double]$r.weight; note = "$($r.note)"; created = "$($r.created)"; hits = 0 })
    }
    $k.ctx.rules = $list.ToArray()
  }
  return $k
}

function Invoke-Classify($cands, $k, $cfg) {
  $out = @()
  foreach ($c in $cands) {
    $d = Classify-Candidate $c $k.mapping ([double]$cfg.confidence_threshold) "$($cfg.unrouted_folder)" `
      $k.learned (Get-IgnoredDomains $cfg) (Get-NeverContextList $cfg) 1.35 `
      $k.ctx 0.85 $k.internal (Get-MultiTerritoryDomains $cfg) `
      (Get-CfgChoice $cfg.filename_stamp @('suffix','prefix','none') 'suffix') (Get-CfgInt $cfg.filename_max_chars 120 40 200) `
      (ConvertTo-BoolSafe $cfg.skip_internal_replies $true) $k.multi (Get-ContentOnlySenders $cfg) `
      (Get-AutoIgnore $cfg) (Get-InternalDomains $cfg) (ConvertTo-BoolSafe $cfg.ignore_internal_replies $true)
    $out += [ordered]@{
      id = "$($c.EntryID)"; customerKey = "$($d.CustomerKey)"; confidence = [double]$d.Confidence; dest = "$($d.DestinationRelPath)"
      stem = "$($d.Stem)"; source = "$($d.MatchSource)"; evidence = "$($d.Evidence)"; ruleId = "$($d.RuleId)"
      also = @($d.AlsoCustomers | ForEach-Object { "$_" }); ambiguity = "$($d.Ambiguity)"
    }
  }
  return ,$out
}

$cfgProd = Read-Json (Join-Path $Fixtures 'config.json')
$extras  = Read-Json (Join-Path $Fixtures 'extras.json')
$g452    = Read-Json (Join-Path $V452 'golden.json')
$cases   = @(Read-Json (Join-Path $Fixtures 'cases.json'))
$cands   = @($g452.candidates) + $cases

# 1) v4.5.3 engine, 22 Oct production knowledge + test extras, production config.
$kProd = Get-Knowledge $Fixtures $extras
$prod = Invoke-Classify $cands $kProd $cfgProd

# 2) v4.5.3 engine on the v4.5.2 fixtures with v4.5.2-equivalent settings
#    (internal_domains "" + ignore_internal_replies false). Must equal the v4.5.2 golden.
$eq = @{}
foreach ($name in @($g452.configs.PSObject.Properties.Name)) {
  $c = $g452.configs.$name.settings | Select-Object *
  $c | Add-Member -NotePropertyName internal_domains -NotePropertyValue '' -Force
  $c | Add-Member -NotePropertyName ignore_internal_replies -NotePropertyValue $false -Force
  $eq[$name] = Invoke-Classify @($g452.candidates) (Get-Knowledge $V452 $null) $c
}

# 3) validation messages
$byKey = @{}; foreach ($r in $kProd.mapping) { $byKey[$r.CustomerKey] = $r }
$teams = @('MIDWESTALPAN', 'TEAMFLORIDAEASTC', 'TEAMTEXASLAMS')
$val = [ordered]@{}
foreach ($v in @('Team,', 'Hi team', 'TREMAIN CUT OFF DATES', 'ocala transfer delay', 'Team,Please be')) {
  $r = Test-NewMultiRoute @{ kind = 'phrase'; value = $v; teams = $teams } $byKey @('ndiof.com')
  $val["multi:$v"] = @($r.errors | ForEach-Object { "$_" })
}
$r = Test-NewMultiRoute @{ kind = 'phrase'; value = 'Team,'; teams = $teams; match = 'regex' } $byKey @('ndiof.com')
$val['multi-regex:Team,'] = @($r.errors | ForEach-Object { "$_" })
$r = Test-NewMultiRoute @{ kind = 'phrase'; value = 'Acme Dealer Supply'; teams = $teams; scope = 'sender' } $byKey @('ndiof.com')
$val['multi-sender-scope'] = @($r.errors | ForEach-Object { "$_" })
$r = Test-NewContextRule @{ phrase = 'Acme Dealer Supply'; customer = 'MIDWESTALPAN'; scope = 'sender' } $byKey
$val['content-sender-scope'] = @($r.errors | ForEach-Object { "$_" })
$r = Test-NewContextRule @{ phrase = 'Acme'; customer = 'MIDWESTALPAN'; scope = 'header' } $byKey
$val['content-bad-scope'] = @($r.errors | ForEach-Object { "$_" })

# 4) automatic learning: colleagues are never auto-learned
$lc = @(
  [pscustomobject]@{ EntryID = 'L1'; SenderAddress = 'kwilliams@ndiof.com' },
  [pscustomobject]@{ EntryID = 'L2'; SenderAddress = 'dlange@ndiof.com' },
  [pscustomobject]@{ EntryID = 'L3'; SenderAddress = 'buyer@newdealer.com' }
)
$ld = @(
  [pscustomobject]@{ EntryID = 'L1'; MatchSource = 'internal-sender' },
  [pscustomobject]@{ EntryID = 'L2'; MatchSource = 'learned-sender' },
  [pscustomobject]@{ EntryID = 'L3'; MatchSource = 'learned-sender' }
)
$lr = @(
  [pscustomobject]@{ EntryID = 'L1'; Status = 'copied_and_flagged'; CustomerKey = 'TEAMTEXASLAMS'; Confidence = 0.97 },
  [pscustomobject]@{ EntryID = 'L2'; Status = 'copied_and_flagged'; CustomerKey = 'TEAMTEXASLAMS'; Confidence = 0.96 },
  [pscustomobject]@{ EntryID = 'L3'; Status = 'copied_and_flagged'; CustomerKey = 'E2G'; Confidence = 0.96 }
)
$store = @{ senders = @{}; domains = @{} }
$n = Update-LearnedFromResults $store $lc $lr @() $ld 0.9 @() @() '' 'run1' @() (Get-InternalDomains $cfgProd)
$learn = [ordered]@{ taught = $n; senders = @($store.senders.Keys | Sort-Object); domains = @($store.domains.Keys | Sort-Object) }

$result = [ordered]@{
  note = "Expected values produced by the Email Archiver v4.5.3 PowerShell engine (archiver-lib.ps1) with scripts/archiver-parity-v453.ps1 on $((Get-Date).ToString('yyyy-MM-dd')). Knowledge: desktop production copy of 22 Oct 2026 + extras.json. Do not edit by hand."
  engine = "PowerShell $($PSVersionTable.PSVersion)"
  candidates = $cands
  prod = $prod
  v452Equivalent = $eq
  validation = $val
  learning = $learn
}
[IO.File]::WriteAllText((Join-Path $Fixtures 'golden.json'), ($result | ConvertTo-Json -Depth 8))
Write-Host ("wrote {0} prod decisions, {1} v452-equivalent configs" -f $prod.Count, $eq.Count)
