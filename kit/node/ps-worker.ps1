# The kit's PowerShell worker (ps.ts): one long-lived Windows PowerShell that runs the agent's scripts, so an agent
# starts PowerShell once instead of once per script. Every Windows process start and exit costs the PC (a console host
# beside it, its DLLs loaded and unloaded), and agents run scripts all day.
#
# Each request is a line on standard input, "<id>|<script, UTF-8, base64>". Each runs in its own runspace, so nothing
# one script sets is seen by the next, and several run at once, as separate powershell.exe processes did. Each answer is
# a line on standard output, "<id>|<0 or 1>|<output, UTF-8, base64>|<error, UTF-8, base64>": 1 when the script failed
# (an error that ended it: the kit's prelude sets $ErrorActionPreference = 'Stop'), as powershell.exe's exit code would
# say. The output is what powershell.exe would have printed: the success stream with Write-Host in its place,
# formatted 120 columns wide, as a console host's buffer is. The worker ends when its input closes.
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
$stdout = New-Object System.IO.StreamWriter ([Console]::OpenStandardOutput()), $utf8
$stdout.AutoFlush = $true
$stdin = New-Object System.IO.StreamReader ([Console]::OpenStandardInput()), $utf8
$b64 = { param([string]$s) [Convert]::ToBase64String($utf8.GetBytes($s)) }

# Runs a script so its output comes back as powershell.exe prints it, Write-Host (stream 6) in its place.
# A script that calls exit is never sent here (ps.ts): in a runspace, exit drops the script's output and its code.
$wrap = 'param([string]$__script) & { & ([ScriptBlock]::Create($__script)) } 6>&1 | Out-String -Stream -Width 120'

$jobs = @{}
$read = $stdin.ReadLineAsync()
while ($true) {
  $waits = @(([System.IAsyncResult]$read).AsyncWaitHandle)
  $ids = @($jobs.Keys)
  foreach ($id in $ids) { $waits += $jobs[$id].ar.AsyncWaitHandle }
  $null = [System.Threading.WaitHandle]::WaitAny($waits, 1000)

  foreach ($id in $ids) {
    $j = $jobs[$id]
    if (-not $j.ar.IsCompleted) { continue }
    $failed = 0; $out = ''; $err = ''
    try {
      $lines = @($j.ps.EndInvoke($j.ar))
      $out = if ($lines.Count) { ($lines -join "`r`n") + "`r`n" } else { '' }
    } catch {
      $failed = 1
      $inner = $_.Exception
      while ($inner.InnerException) { $inner = $inner.InnerException }
      $err = if ($inner.ErrorRecord -and $inner.ErrorRecord.Exception) { $inner.ErrorRecord.Exception.Message } else { $inner.Message }
    }
    $j.ps.Dispose()
    $jobs.Remove($id)
    $stdout.WriteLine("$id|$failed|$(& $b64 $out)|$(& $b64 $err)")
  }

  if ($read.IsCompleted) {
    $line = $read.Result
    if ($null -eq $line) { break }
    $bar = $line.IndexOf('|')
    if ($bar -gt 0) {
      $id = $line.Substring(0, $bar)
      try {
        $script = $utf8.GetString([Convert]::FromBase64String($line.Substring($bar + 1)))
        $ps = [powershell]::Create()
        $null = $ps.AddScript($wrap).AddArgument($script)
        $jobs[$id] = @{ ps = $ps; ar = $ps.BeginInvoke() }
      } catch {
        $stdout.WriteLine("$id|1||$(& $b64 "the worker couldn't start the script: $($_.Exception.Message)")")
      }
    }
    $read = $stdin.ReadLineAsync()
  }
}
foreach ($j in $jobs.Values) { try { $j.ps.Stop(); $j.ps.Dispose() } catch { } }
