import { existsSync } from 'node:fs';
import { powershell, psQuote } from './ps.ts';

/**
 * Small file operations beyond Node's own (kit 2.88.0, from the Miller's files.ts, which the Chronicler carried
 * unchanged): a copy's times set to its original's, and a file sent to the Recycle Bin. Both go through the agent's
 * PowerShell worker (ps.ts). The Miller's writeJsonFirmly is the kit's writeJson (store.ts), which has tried a refused
 * rename again since kit 2.73.3.
 */

/** Sets a file's created and modified times (Node can set only the modified one). */
export async function setFileTimes(file: string, created: Date, modified: Date): Promise<void> {
  await powershell(
    `[IO.File]::SetCreationTimeUtc(${psQuote(file)}, [DateTime]::Parse(${psQuote(created.toISOString())}).ToUniversalTime()); ` +
      `[IO.File]::SetLastWriteTimeUtc(${psQuote(file)}, [DateTime]::Parse(${psQuote(modified.toISOString())}).ToUniversalTime())`,
    { timeoutMs: 30_000 },
  );
}

/**
 * Sends one file to the Recycle Bin, the way Explorer's Delete does, so it can be restored from there.
 *
 * Never a permanent delete. Without dialogs, Windows silently destroys a file it can't recycle: one on
 * a drive with no Recycle Bin (network, removable), on a drive whose bin is turned off, or one bigger
 * than the bin. So those are checked first, and the file is left where it is with the reason.
 */
export async function recycle(file: string): Promise<void> {
  await powershell(
    `$full = [IO.Path]::GetFullPath(${psQuote(file)})
$root = [IO.Path]::GetPathRoot($full)
if ($root -notmatch '^[A-Za-z]:\\\\$') { throw "it isn't on a lettered local drive, so it has no Recycle Bin" }
$drive = New-Object IO.DriveInfo($root)
if ("$($drive.DriveType)" -ne 'Fixed') { throw "it is on a $($drive.DriveType) drive, which has no Recycle Bin" }
$vol = Get-CimInstance Win32_Volume -Filter ("DriveLetter='" + $root.Substring(0, 2) + "'")
$guid = [regex]::Match("$($vol.DeviceID)", '\\{[^}]+\\}').Value
$bin = $null
if ($guid) { $bin = Get-ItemProperty -LiteralPath "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume\\$guid" -ErrorAction SilentlyContinue }
if ($bin -and $bin.NukeOnDelete -eq 1) { throw 'the Recycle Bin is turned off for this drive' }
$maxMB = if ($bin -and $bin.MaxCapacity) { [double]$bin.MaxCapacity } else { $drive.TotalSize / 1MB * 0.05 }
$size = (Get-Item -LiteralPath $full).Length
if ($size / 1MB -ge $maxMB) { throw ("it is bigger than this drive's Recycle Bin ({0:N0} MB)" -f $maxMB) }
Add-Type -AssemblyName Microsoft.VisualBasic
[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($full, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin, [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)`,
    { timeoutMs: 60_000 },
  );
  if (existsSync(file)) throw new Error('Windows reported success but the file is still there');
}
