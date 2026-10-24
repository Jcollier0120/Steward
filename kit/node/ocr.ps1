# The staff's text reader's engine for now (ocr.ts, spec/OCR.md): Windows' built-in OCR (Windows.Media.Ocr, on the
# processor) over pictures and PDF pages, the PDF pages rendered with Windows.Data.Pdf, with a cloud-only guard.
# Windows PowerShell 5.1 only: it projects WinRT types, pwsh 7 does not.
#
# ocr.ts prepends `$ListFile = '<path>'`, a JSON file:
#   {"scale":1|"auto","boxes":false,"orient":true,"pdfMaxPages":5,"pdfScale":2,"tmpDir":"...",
#    "jobs":[{"i":0,"path":"...","kind":"image"|"pdf","thumb":"...png"|null,"pages":[0,3]|null}]}
# and reads one JSON line per job:
#   {"i","ok":true,"ms","pageCount","read":[{"page","text","width","height","lines"?}]} or {"i","ok":false,"error","cloudOnly"}
# - scale "auto" enlarges a picture under 1,000 pixels twice (small pictures read better so), else reads it as it is.
# - boxes: each read page's lines, each with its words' boxes ({"t","x","y","w","h"}) in the picture's own pixels
#   (a PDF page's: as rendered at pdfScale).
# - orient false reads a photo as stored, ignoring its EXIF orientation.
# - pages (PDFs): the pages to read, 0-based; null for the first pdfMaxPages. A PDF's pages are rendered to PNGs in
#   tmpDir, read, and deleted. `thumb` is where to save a small render of page 1 for the page's thumbnail.
# - render (kit 2.114.0): PDFs' pages are only rendered, for the model to read (ocr-npu.ts): each is kept in tmpDir and
#   answered as {"page","png","frame"} in "rendered" instead of "read" (frame: the width it was rendered for, at pdfScale;
#   Windows may render it wider, at the display's scale). No OCR language is needed for it.
# Every answer is ASCII: anything else goes as \uXXXX, so no console code page can change it (437 made a bullet a bell,
# which broke the line, kit 2.102.0).
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

# One answer line, ASCII only.
function Out-Answer($o) {
  $j = ConvertTo-Json -Compress -Depth 8 -InputObject $o
  [regex]::Replace($j, '[^\x20-\x7e]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
}

$list = Get-Content -LiteralPath $ListFile -Raw -Encoding UTF8 | ConvertFrom-Json
$render = [bool]$list.render
if (-not $render) {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) { throw 'no OCR language installed (Settings > Time & language > Language)' }
}
$maxDim = [double][Windows.Media.Ocr.OcrEngine]::MaxImageDimension
$boxes = [bool]$list.boxes
$orient = $list.orient -ne $false

# OneDrive "online-only" files: opening one downloads it. Offline, RecallOnOpen, RecallOnDataAccess.
function Test-CloudOnly([string]$path) {
  $a = [int][System.IO.File]::GetAttributes($path)
  return [bool](($a -band 0x1000) -or ($a -band 0x40000) -or ($a -band 0x400000))
}

function Read-Image([string]$path, $scale) {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    if ($orient) { $w = [int]$decoder.OrientedPixelWidth; $h = [int]$decoder.OrientedPixelHeight } else { $w = [int]$decoder.PixelWidth; $h = [int]$decoder.PixelHeight }
    if ("$scale" -eq 'auto') { $want = if ([Math]::Max($w, $h) -lt 1000) { 2.0 } else { 1.0 } } else { $want = [double]$scale }
    # Enlarge small text if asked; shrink what is bigger than the engine takes (a phone photo).
    $s = [Math]::Min($want, $maxDim / [Math]::Max($w, $h))
    $tf = New-Object Windows.Graphics.Imaging.BitmapTransform
    # The transform scales the stored pixels, before any rotation.
    $tf.ScaledWidth = [uint32][Math]::Max(1, [Math]::Floor([int]$decoder.PixelWidth * $s)); $tf.ScaledHeight = [uint32][Math]::Max(1, [Math]::Floor([int]$decoder.PixelHeight * $s))
    $tf.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant
    $exif = if ($orient) { [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation } else { [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation }
    # The first frame: a GIF's first, a TIFF's first page.
    $bmp = Await ($decoder.GetSoftwareBitmapAsync(
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $tf,
        $exif, [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
    $page = [ordered]@{ text = (@($res.Lines | ForEach-Object { $_.Text }) -join "`n"); width = $w; height = $h }
    if ($boxes) {
      $page.lines = @(foreach ($l in $res.Lines) {
          [ordered]@{
            text  = $l.Text
            words = @(foreach ($wd in $l.Words) {
                $r = $wd.BoundingRect
                [ordered]@{ t = $wd.Text; x = [Math]::Round($r.X / $s, 1); y = [Math]::Round($r.Y / $s, 1); w = [Math]::Round($r.Width / $s, 1); h = [Math]::Round($r.Height / $s, 1) }
              })
          }
        })
    }
    return $page
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
  $want = if ($null -ne $job.pages) { @($job.pages | ForEach-Object { [int]$_ } | Where-Object { $_ -ge 0 -and $_ -lt $n }) } else { @(0..($n - 1) | Where-Object { $_ -ge 0 }) }
  if ($n -lt 1) { $want = @() }
  if ($job.thumb -and $count -gt 0) {
    $page = $doc.GetPage([uint32]0)
    try { Save-PdfPage $page $job.thumb 320 } finally { $page.Dispose() }
  }
  $read = @(foreach ($p in $want) {
      $page = $doc.GetPage([uint32]$p)
      try {
        $png = Join-Path $list.tmpDir ('job{0}-p{1}.png' -f $job.i, $p)
        # Page sizes are in 1/96 inch, so pdfScale 2 renders at 192 dpi.
        $frame = [Math]::Min($maxDim, $page.Size.Width * [double]$list.pdfScale)
        Save-PdfPage $page $png $frame
        if ($render) {
          [ordered]@{ page = $p; png = $png; frame = [Math]::Round($frame) }
        } else {
          try { $r = Read-Image $png 1 } finally { Remove-Item -LiteralPath $png -Force -ErrorAction SilentlyContinue }
          # Windows renders at the display's scale too (twice as wide at 200%): the page's size and boxes are given
          # at pdfScale, as the text layer's are, whatever the display.
          $f = if ($r.width -gt 0) { [Math]::Round($frame) / $r.width } else { 1 }
          if ([Math]::Abs($f - 1) -gt 0.001) {
            $r.width = [int][Math]::Round($r.width * $f); $r.height = [int][Math]::Round($r.height * $f)
            if ($boxes) { foreach ($l in $r.lines) { foreach ($wd in @($l.words)) { $wd.x = [Math]::Round($wd.x * $f, 1); $wd.y = [Math]::Round($wd.y * $f, 1); $wd.w = [Math]::Round($wd.w * $f, 1); $wd.h = [Math]::Round($wd.h * $f, 1) } } }
          }
          $r.page = $p
          $r
        }
      } finally { $page.Dispose() }
    })
  return @{ read = $read; pageCount = $count }
}

foreach ($job in $list.jobs) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    if (Test-CloudOnly $job.path) {
      Out-Answer ([ordered]@{ i = $job.i; ok = $false; cloudOnly = $true; error = 'online-only (not on this PC)' })
      continue
    }
    if ($job.kind -eq 'pdf') {
      $r = Read-Pdf $job
      $key = if ($render) { 'rendered' } else { 'read' }
      $a = [ordered]@{ i = $job.i; ok = $true; ms = $sw.ElapsedMilliseconds; pageCount = $r.pageCount }
      $a[$key] = @($r.read)
      Out-Answer $a
    } elseif ($render) {
      Out-Answer ([ordered]@{ i = $job.i; ok = $false; error = 'only PDFs are rendered' })
    } else {
      $r = Read-Image $job.path $list.scale
      $r.page = 0
      Out-Answer ([ordered]@{ i = $job.i; ok = $true; ms = $sw.ElapsedMilliseconds; pageCount = 1; read = @($r) })
    }
  } catch {
    $ex = $_.Exception
    while ($ex.InnerException) { $ex = $ex.InnerException }
    $msg = $ex.Message
    Out-Answer ([ordered]@{ i = $job.i; ok = $false; error = "$msg".Trim() })
  }
}
