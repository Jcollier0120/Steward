# The text reader's check's pictures (ocr-check.ts, spec/OCR.md), drawn with GDI+ (System.Drawing), with the text each
# one shows. ocr-check.ts prepends `$SpecFile = '<spec/ocr-check.json>'` and `$Out = '<folder>'`, and reads <Out>\gdi.json:
#   [{ file, kind, set, group, px, theme, lines: [..] }]
# - The screens and pages are the Snapdragon Dev Manager's bench fixtures of 2026-10-23, drawn the same way from the same
#   seed, so their figures compare with the baseline in spec/OCR.md: 20 screenshots (1280x720; four themes; 11, 12, 13,
#   15 and 18 px; the screen fonts mixed line by line; ClearType) and 5 pages (31 px at about 200 dpi in the page fonts,
#   and one at about 100 dpi).
# - The held-out set: its own strings and fonts (never used to train a model), ClearType and grey anti-aliasing.
# - A page drawn for scanning (150 dpi, saved as a JPEG), which ocr-check.ts wraps in a PDF.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force $Out | Out-Null
$spec = Get-Content -LiteralPath $SpecFile -Raw -Encoding UTF8 | ConvertFrom-Json
function C($hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }
$truth = New-Object System.Collections.Generic.List[object]
$n = 0

function Draw($rng, $set, $group, $kind, $w, $h, $bg, $fg, $fontName, $fonts, $px, $pool, $hint, [switch]$Jpeg) {
  $script:n++
  $file = '{0:D2}-{1}.{2}' -f $script:n, $kind, $(if ($Jpeg) { 'jpg' } else { 'png' })
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.TextRenderingHint = $hint
  $g.Clear((C $bg))
  $brush = New-Object System.Drawing.SolidBrush (C $fg)
  $fmt = [System.Drawing.StringFormat]::GenericTypographic
  $fmt.FormatFlags = $fmt.FormatFlags -bor [System.Drawing.StringFormatFlags]::NoWrap -bor [System.Drawing.StringFormatFlags]::MeasureTrailingSpaces
  $lines = New-Object System.Collections.Generic.List[string]
  $y = [int]($px * 1.5)
  $order = $pool | Sort-Object { $rng.Next() }
  foreach ($s in $order) {
    if ($y + $px * 2 -gt $h) { break }
    $f = New-Object System.Drawing.Font ($(if ($fontName) { $fontName } else { $fonts[$rng.Next($fonts.Count)] })), $px, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
    $size = $g.MeasureString($s, $f, 100000, $fmt)
    if ($size.Width -gt $w - 48) { $f.Dispose(); continue }
    $g.DrawString($s, $f, $brush, [single]24, [single]$y, $fmt)
    $lines.Add($s)
    $y += [int]($px * 1.9)
    $f.Dispose()
  }
  $path = Join-Path $Out $file
  if ($Jpeg) {
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
    $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
    $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]85)
    $bmp.Save($path, $codec, $ep)
  } else { $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png) }
  $g.Dispose(); $bmp.Dispose()
  $truth.Add([ordered]@{ file = $file; kind = $kind; set = $set; group = $group; px = $px; theme = $bg + '/' + $fg; lines = @($lines) })
}

$themes = @(
  @{ name = 'dark'; bg = '#1E1E1E'; fg = '#D4D4D4' },
  @{ name = 'light'; bg = '#FFFFFF'; fg = '#1F1F1F' },
  @{ name = 'grey'; bg = '#FFFFFF'; fg = '#6B7280' },
  @{ name = 'blue'; bg = '#1D4ED8'; fg = '#FFFFFF' }
)
$ui = @($spec.ui)
$prose = @($spec.prose)
$clear = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$aa = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

# The bench's set, in its order: one random sequence for all of it.
$rng = New-Object System.Random ([int]$spec.seed)
$screenFonts = @($spec.screenFonts)
foreach ($t in $themes) {
  foreach ($px in 11, 12, 13, 15, 18) {
    Draw $rng 'screen' "screen ${px}px" "screen-$($t.name)-$px" 1280 720 $t.bg $t.fg $null $screenFonts $px $ui $clear
  }
}
foreach ($face in @($spec.pageFonts)) {
  Draw $rng 'page' 'page' ('page-' + ($face -replace ' ', '')) 1700 2200 '#FFFFFF' '#111111' $face $null 31 ($prose + $ui) $aa
}
Draw $rng 'page' 'page' 'page-lowres' 850 1100 '#FBFBF8' '#222222' 'Times New Roman' $null 15 ($prose + $ui) $aa

# The held-out set: its own strings and fonts, ClearType and grey anti-aliasing.
$rng2 = New-Object System.Random ([int]$spec.seed + 1)
$hoUi = @($spec.heldOut.ui)
$hoProse = @($spec.heldOut.prose)
$hoFonts = @($spec.heldOut.fonts)
foreach ($t in $themes[0], $themes[1], $themes[3]) {
  foreach ($px in 12, 14) {
    Draw $rng2 'held-out' 'held-out screen' "heldout-screen-$($t.name)-$px" 1280 720 $t.bg $t.fg $null $hoFonts $px $hoUi $(if ($px -eq 14) { $aa } else { $clear })
  }
}
Draw $rng2 'held-out' 'held-out page' 'heldout-page' 1700 2200 '#FFFFFF' '#111111' $null $hoFonts 31 ($hoProse + $hoUi) $aa

# A page to scan: 150 dpi, 12 pt, a JPEG.
$rng3 = New-Object System.Random ([int]$spec.seed + 2)
Draw $rng3 'pdf' 'pdf scan' 'scan-page' 1275 1650 '#FFFFFF' '#151515' 'Arial' $null 25 ($prose + $ui) $aa -Jpeg

$truth | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 (Join-Path $Out 'gdi.json')
"$($truth.Count) pictures"
