# Reads the text in images and PDFs with Windows' built-in OCR (Windows.Media.Ocr, on the CPU).
# Adapted from npu-agent's src/screens/ocr.ps1 (now Reeve): the same WinRT
# plumbing and decoder, plus PDF pages rendered with Windows.Data.Pdf and a cloud-only guard.
# Windows PowerShell 5.1 only: it projects WinRT types, pwsh 7 does not.
#
# ocr.ts prepends `$ListFile = '<path>'`, a JSON file:
#   {"scale":1,"pdfMaxPages":5,"pdfScale":2,"tmpDir":"...","jobs":[{"i":0,"path":"...","kind":"image"|"pdf","thumb":"...png"|null}]}
# and reads one JSON line per job:
#   {"i","ok":true,"text","ms","pages","pageCount"} or {"i","ok":false,"error","cloudOnly"}
# A PDF's pages are rendered to PNGs in tmpDir, read, and deleted. `thumb` (PDFs only) is where to
# save a small render of page 1 for the page's thumbnail.
Remove-TypeData System.Array -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
$methods = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asTaskOp = $methods | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
$asTaskAction = $methods | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
function Await($op, [type]$type) {
  $t = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op))
  $null = $t.Wait(-1)
  $t.Result
}
function AwaitAction($op) {
  $t = $asTaskAction.Invoke($null, @($op))
  $null = $t.Wait(-1)
}

$list = Get-Content -LiteralPath $ListFile -Raw -Encoding UTF8 | ConvertFrom-Json
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { throw 'no OCR language installed (Settings > Time & language > Language)' }
$maxDim = [double][Windows.Media.Ocr.OcrEngine]::MaxImageDimension

# OneDrive "online-only" files: opening one downloads it. Offline, RecallOnOpen, RecallOnDataAccess.
function Test-CloudOnly([string]$path) {
  $a = [int][System.IO.File]::GetAttributes($path)
  return [bool](($a -band 0x1000) -or ($a -band 0x40000) -or ($a -band 0x400000))
}

function Read-Image([string]$path, [double]$scale) {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $w = [int]$decoder.PixelWidth; $h = [int]$decoder.PixelHeight
    # Enlarge small text if asked; shrink what is bigger than the engine takes (a phone photo).
    $s = [Math]::Min($scale, $maxDim / [Math]::Max($w, $h))
    $tf = New-Object Windows.Graphics.Imaging.BitmapTransform
    $tf.ScaledWidth = [uint32][Math]::Max(1, [Math]::Floor($w * $s)); $tf.ScaledHeight = [uint32][Math]::Max(1, [Math]::Floor($h * $s))
    $tf.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant
    # The first frame: a GIF's first, a TIFF's first page.
    $bmp = Await ($decoder.GetSoftwareBitmapAsync(
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $tf,
        [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation, [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
    return (@($res.Lines | ForEach-Object { $_.Text }) -join "`n")
  } finally { $stream.Dispose() }
}

function Save-PdfPage($page, [string]$path, [double]$width) {
  $folder = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync([IO.Path]::GetDirectoryName($path))) ([Windows.Storage.StorageFolder])
  $out = Await ($folder.CreateFileAsync([IO.Path]::GetFileName($path), [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
  $ws = Await ($out.OpenAsync([Windows.Storage.FileAccessMode]::ReadWrite)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $opt = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $opt.DestinationWidth = [uint32][Math]::Max(1, [Math]::Round($width))
    AwaitAction ($page.RenderToStreamAsync($ws, $opt))
  } finally { $ws.Dispose() }
}

function Read-Pdf($job) {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($job.path)) ([Windows.Storage.StorageFile])
  $doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
  $count = [int]$doc.PageCount
  $n = [Math]::Min($count, [int]$list.pdfMaxPages)
  $texts = @()
  for ($p = 0; $p -lt $n; $p++) {
    $page = $doc.GetPage([uint32]$p)
    try {
      if ($p -eq 0 -and $job.thumb) { Save-PdfPage $page $job.thumb 320 }
      $png = Join-Path $list.tmpDir ('job{0}-p{1}.png' -f $job.i, $p)
      # Page sizes are in 1/96 inch, so pdfScale 2 renders at 192 dpi.
      Save-PdfPage $page $png ([Math]::Min($maxDim, $page.Size.Width * [double]$list.pdfScale))
      try { $texts += Read-Image $png 1 } finally { Remove-Item -LiteralPath $png -Force -ErrorAction SilentlyContinue }
    } finally { $page.Dispose() }
  }
  return @{ text = ($texts -join "`n`n"); pages = $n; pageCount = $count }
}

foreach ($job in $list.jobs) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    if (Test-CloudOnly $job.path) {
      ConvertTo-Json -Compress -InputObject ([ordered]@{ i = $job.i; ok = $false; cloudOnly = $true; error = 'online-only (not on this PC)' })
      continue
    }
    if ($job.kind -eq 'pdf') {
      $r = Read-Pdf $job
      ConvertTo-Json -Compress -InputObject ([ordered]@{ i = $job.i; ok = $true; text = $r.text; ms = $sw.ElapsedMilliseconds; pages = $r.pages; pageCount = $r.pageCount })
    } else {
      $text = Read-Image $job.path ([double]$list.scale)
      ConvertTo-Json -Compress -InputObject ([ordered]@{ i = $job.i; ok = $true; text = $text; ms = $sw.ElapsedMilliseconds; pages = 1; pageCount = 1 })
    }
  } catch {
    $ex = $_.Exception
    while ($ex.InnerException) { $ex = $ex.InnerException }
    $msg = $ex.Message
    ConvertTo-Json -Compress -InputObject ([ordered]@{ i = $job.i; ok = $false; error = "$msg".Trim() })
  }
}
