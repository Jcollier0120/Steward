# The helpers a guard's installer shares (the Steward's kit, guard-kit.ps1, kit 2.87.0): the Watchman's and the
# Lamplighter's install-guard.ps1 had them each, with their own prefixes (Write-WOut, Write-LOut). Windows PowerShell
# 5.1. Dot-sourced, never run: it has no parameters, never exits, and only sets its own variables ($script:Guard*).
#
#   . (Join-Path $PSScriptRoot 'guard-kit.ps1')
#   Initialize-GuardKit -Log $Log -WhatIf:$WhatIf
#
# WHAT AN AGENT MUST DO TO USE IT. A guard's scheduled tasks run as SYSTEM from its own bin\ folder, which only an
# administrator can change, and install-guard.ps1 copies every script there only after checking its SHA-256 against
# the release's manifest.json (and checks the copies again). This file is one of those scripts the moment
# install-guard.ps1 (or guard.ps1) dot-sources it, so the agent:
#   1. copies it beside install-guard.ps1 (src\guard\guard-kit.ps1; guard.ts' copyGuardKit), before its release build
#      writes manifest.json, so the manifest carries its SHA-256;
#   2. names it in GUARD_SCRIPTS (guard.ts, tools/guard-manifest.ts) and in install-guard.ps1's $script:Files, so it is
#      checked, copied to bin\ and checked again there with the rest. A guard set up before then has none in bin\, and
#      the agent's page says the guard is behind until Update the guard.
# It is trusted exactly as install-guard.ps1 is: it is dot-sourced from the same folder, before any check, as
# install-guard.ps1 itself runs from it unchecked; in bin\ it is the release's own, checked like the rest.
#
# Every hardening of the agents' copies is kept as it was: the log is only ever a file made afresh (CreateNew, never
# one already there, which could be a link to one of Windows' own), never in a folder that is itself a link, and held
# open until the end; a folder is trusted only when it and everything in it belong to SYSTEM, Administrators or
# TrustedInstaller; scripts are compared by their SHA-256 in lower case, case-sensitively; rights are set from the SDDL
# the agent gives. Nothing here is done under -WhatIf, and Invoke-Do refuses to do anything before Initialize-GuardKit.

$script:GuardLog = $null
# $null until Initialize-GuardKit: Invoke-Do then refuses, rather than act without knowing whether it's -WhatIf.
$script:GuardWhatIf = $null
$script:GuardLogWriter = $null
# Every line Write-Out printed, for the agent's tests.
$script:GuardLines = New-Object System.Collections.ArrayList

# Where to log ($Log, the agent's data folder; none: no log), and whether this is a dry run (-WhatIf).
function Initialize-GuardKit([string]$Log, [switch]$WhatIf) {
  $script:GuardLog = $Log
  $script:GuardWhatIf = [bool]$WhatIf
}

# The log is in the agent's data folder, which the user's own programs can write to, and this runs as an
# administrator: so it's made afresh (never an existing file, which could be a link to one of Windows' own), never in a
# folder that is itself a link, and held open until the end, so it can't be swapped for a link half-way.
function Open-Log {
  if (-not $script:GuardLog -or $script:GuardLogWriter) { return }
  try {
    $dir = Split-Path -Parent $script:GuardLog
    if (((Get-Item -LiteralPath $dir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return }
    $fs = [IO.File]::Open($script:GuardLog, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $script:GuardLogWriter = New-Object IO.StreamWriter($fs, (New-Object Text.UTF8Encoding $false))
  } catch { }
}
function Close-Log { if ($script:GuardLogWriter) { try { $script:GuardLogWriter.Dispose() } catch { }; $script:GuardLogWriter = $null } }

function Write-Out([string]$Line) {
  [void]$script:GuardLines.Add($Line)
  [Console]::Out.WriteLine($Line)
  Open-Log
  if ($script:GuardLogWriter) { try { $script:GuardLogWriter.WriteLine($Line); $script:GuardLogWriter.Flush() } catch { } }
}

# One step: under -WhatIf only said, else said and done.
function Invoke-Do([string]$What, [scriptblock]$Do) {
  if ($null -eq $script:GuardWhatIf) { throw "guard-kit.ps1: Initialize-GuardKit wasn't called, so nothing is done ($What)." }
  if ($script:GuardWhatIf) { Write-Out "WhatIf: $What"; return }
  Write-Out $What
  & $Do
}

function Invoke-Native([string]$File, [string[]]$Arguments) {
  $out = & $File @Arguments 2>&1 | Out-String
  return @{ code = $LASTEXITCODE; out = $out.Trim() }
}

function Test-Admin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function ConvertTo-XmlText([string]$s) { return [Security.SecurityElement]::Escape($s) }

# Who owns a file or folder, as a SID. The tests replace this.
function Get-OwnerSid([string]$Path) {
  return (Get-Acl -LiteralPath $Path).GetOwner([Security.Principal.SecurityIdentifier]).Value
}

# A folder is the guard's own when it and everything in it belong to SYSTEM, Administrators or TrustedInstaller.
# Anything else may have been planted before the guard was turned on. -Except names subfolders whose contents anyone
# may write (the Lamplighter's inbox): what is in them isn't asked about, the subfolder itself still is.
function Test-Trusted([string]$Root, [string[]]$Except = @()) {
  $trusted = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  if (-not (Test-Path -LiteralPath $Root)) { return $true }
  if ($trusted -notcontains (Get-OwnerSid $Root)) { return $false }
  $skip = @($Except | Where-Object { $_ } | ForEach-Object { (Join-Path $Root $_).TrimEnd('\') + '\' })
  foreach ($i in @(Get-ChildItem -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue)) {
    $inside = $false
    foreach ($s in $skip) { if ($i.FullName.StartsWith($s, [StringComparison]::OrdinalIgnoreCase)) { $inside = $true; break } }
    if ($inside) { continue }
    if ($trusted -notcontains (Get-OwnerSid $i.FullName)) { return $false }
  }
  return $true
}

# The scripts' SHA-256 as the release recorded them (manifest.json beside them): @{ hashes = @{ name = sha256 } }, or
# @{ error } when there is none to trust. $Files: the scripts it must name (the agent's $script:Files); none is an error.
function Read-ScriptManifest([string]$Dir, [string[]]$Files) {
  if (-not $Files -or $Files.Count -eq 0) { return @{ error = 'guard-kit.ps1: no scripts were named to check.' } }
  $file = Join-Path $Dir 'manifest.json'
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return @{ error = "There's no manifest.json in $Dir (a release carries one, with each script's SHA-256): install a release, and turn the guard on from it." } }
  try { $m = [IO.File]::ReadAllText($file) | ConvertFrom-Json -ErrorAction Stop } catch { return @{ error = "$file isn't JSON: $($_.Exception.Message)" } }
  $hashes = @{}
  foreach ($f in $Files) {
    $h = [string]$m.files.$f
    if ($h -cnotmatch '^[0-9a-f]{64}\z') { return @{ error = "$file gives no SHA-256 for $f." } }
    $hashes[$f] = $h
  }
  return @{ hashes = $hashes }
}

# The scripts in $Dir that differ from the manifest's SHA-256, or are missing: none when all match. No scripts named
# is never "all match".
function Test-ScriptHashes([string]$Dir, $Hashes, [string[]]$Files) {
  if (-not $Files -or $Files.Count -eq 0) { return , @('(no scripts named)') }
  $bad = @()
  foreach ($f in $Files) {
    $p = Join-Path $Dir $f
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { $bad += "$f (missing)"; continue }
    if ((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Hashes[$f]) { $bad += $f }
  }
  return , $bad
}

# A folder's rights, from SDDL (the agent's own: its root's, its inbox's).
function Set-FolderRights([string]$Path, [string]$Sddl) {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetSecurityDescriptorSddlForm($Sddl)
  [IO.Directory]::SetAccessControl($Path, $acl)
}

# ONE GUARD FOR THE WHOLE PC (kit 2.96.0). A guard acts on the PC itself (its graphics drivers, its System Protection
# and restore points), so there is one per PC, in one folder under one set of task names, whichever accounts have its
# agent: two would fight over the same driver and the same restore points. With Castellan for everyone on a PC, each
# Windows account may have the agent, so turning the guard off from one account mustn't take it from another that still
# has it. Such an account only lets go of it (a mark, <Root>\let-go\<its SID>, which every account may read: its agent
# may then be uninstalled), and the guard is turned off once no other account holds it. An account holds it while its
# agent is installed (<profile>\.<id>\app) and it hasn't let go; turning the guard on again holds it again.

# The user accounts on this PC and their profile folders, from Windows' ProfileList: @(@{ sid; profile }). Local and
# Microsoft accounts (S-1-5-21-) and work or school ones (S-1-12-1-), not Windows' own. The tests replace this.
function Get-ProfileList {
  $key = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList'
  $list = @()
  foreach ($k in @(Get-ChildItem -LiteralPath $key -ErrorAction SilentlyContinue)) {
    $sid = [string]$k.PSChildName
    if ($sid -notmatch '^S-1-(5-21|12-1)-[0-9-]+\z') { continue }
    $p = [string](Get-ItemProperty -LiteralPath $k.PSPath -Name ProfileImagePath -ErrorAction SilentlyContinue).ProfileImagePath
    if ($p) { $list += @{ sid = $sid; profile = [Environment]::ExpandEnvironmentVariables($p) } }
  }
  return , $list
}

# The account the guard is turned on or off for: the SID its agent gave (-Account), else the account this runs as.
function Get-AccountSid([string]$Account) {
  if ($Account -match '^S-1-[0-9-]+\z') { return $Account }
  return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}

# Whether an account has let go of the guard: its mark in <Root>\let-go.
function Test-LetGo([string]$Root, [string]$Sid) {
  if ($Sid -notmatch '^S-1-[0-9-]+\z') { return $false }
  return [bool](Test-Path -LiteralPath (Join-Path $Root "let-go\$Sid") -PathType Leaf)
}

# The other accounts on this PC that still hold the guard: @(@{ sid; account }), each with the agent installed
# (<profile>\.$Id\app) and no mark of having let go. None while the guard isn't there ($Root missing).
function Get-OtherHolders([string]$Root, [string]$Id, [string]$Sid) {
  $held = @()
  if (-not (Test-Path -LiteralPath $Root)) { return , $held }
  $profiles = Get-ProfileList
  foreach ($p in $profiles) {
    if ($p.sid -eq $Sid) { continue }
    if (-not (Test-Path -LiteralPath (Join-Path $p.profile ".$Id\app") -PathType Container)) { continue }
    if (Test-LetGo $Root $p.sid) { continue }
    $held += @{ sid = $p.sid; account = (Split-Path -Leaf $p.profile) }
  }
  return , $held
}

# This account lets go of the guard, which other accounts still hold: its mark in <Root>\let-go, owned by
# Administrators as everything there is (whatever owner Windows gives an elevated file), so Test-Trusted still trusts
# the folder when the guard is turned on again. Call it only for a folder Test-Trusted trusts: one it doesn't is no
# guard to share, and is turned off for every account as before.
function Set-LetGo([string]$Root, [string]$Sid) {
  if ($Sid -notmatch '^S-1-[0-9-]+\z') { throw "$Sid isn't an account's SID." }
  $dir = Join-Path $Root 'let-go'
  $f = Join-Path $dir $Sid
  Invoke-Do "Mark that this account lets go of the guard: $f" {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    [IO.File]::WriteAllText($f, [DateTime]::UtcNow.ToString('o'))
    $r = Invoke-Native (Join-Path $env:SystemRoot 'System32\icacls.exe') @($dir, '/setowner', '*S-1-5-32-544', '/t', '/c', '/q')
    if ($r.code -ne 0) {
      Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
      throw "icacls /setowner: $($r.out)"
    }
  }
}

# This account holds the guard again (it turns it on): its mark, if it let go before, removed.
function Clear-LetGo([string]$Root, [string]$Sid) {
  if ($Sid -notmatch '^S-1-[0-9-]+\z') { return }
  $f = Join-Path $Root "let-go\$Sid"
  if (-not (Test-Path -LiteralPath $f)) { return }
  Invoke-Do "Remove ${f}: this account holds the guard again" { Remove-Item -LiteralPath $f -Force }
}

# A task from its XML: written as UTF-16 with a byte-order mark (the XML says UTF-16), then schtasks /Create /XML.
function Register-Task([string]$Name, [string]$Xml, [string]$File) {
  Invoke-Do "Write $File and register the task $Name from it: schtasks /Create /TN $Name /XML `"$File`" /F" {
    $bytes = [Text.Encoding]::Unicode.GetPreamble() + [Text.Encoding]::Unicode.GetBytes($Xml)
    [IO.File]::WriteAllBytes($File, $bytes)
    $r = Invoke-Native (Join-Path $env:SystemRoot 'System32\schtasks.exe') @('/Create', '/TN', $Name, '/XML', $File, '/F')
    if ($r.code -ne 0) { throw "schtasks couldn't register ${Name}: $($r.out)" }
  }
}
