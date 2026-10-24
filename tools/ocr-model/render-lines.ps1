# Renders text lines for training (draw.py): each line on its own canvas as a screen draws it, saved as a PNG, with its
# ink box. Prepend $Jobs = '<jobs.json>'. jobs.json: {"out": dir, "items": [{"id","text","font","bold","italic","px",
# "bg","fg","how": "gdiplus-cleartype"|"gdiplus-aa"|"gdiplus-aa-grid"|"gdi-cleartype"|"gdi-aa"|"gdi-mono","padX","padY"}]}
# Writes <out>\<id>.png and prints one line per item: id<TAB>x<TAB>y<TAB>w<TAB>h (the ink's box), or id<TAB>error.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$j = Get-Content -LiteralPath $Jobs -Raw -Encoding UTF8 | ConvertFrom-Json
$out = $j.out
New-Item -ItemType Directory -Force $out | Out-Null
function C($hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }
$fmt = [System.Drawing.StringFormat]::GenericTypographic
$fmt.FormatFlags = $fmt.FormatFlags -bor [System.Drawing.StringFormatFlags]::NoWrap -bor [System.Drawing.StringFormatFlags]::MeasureTrailingSpaces
$tf = [System.Windows.Forms.TextFormatFlags]::NoPadding -bor [System.Windows.Forms.TextFormatFlags]::NoPrefix -bor [System.Windows.Forms.TextFormatFlags]::SingleLine
$sb = New-Object System.Text.StringBuilder
foreach ($it in $j.items) {
  try {
    $style = [System.Drawing.FontStyle]::Regular
    if ($it.bold) { $style = $style -bor [System.Drawing.FontStyle]::Bold }
    if ($it.italic) { $style = $style -bor [System.Drawing.FontStyle]::Italic }
    $font = New-Object System.Drawing.Font $it.font, ([single]$it.px), $style, ([System.Drawing.GraphicsUnit]::Pixel)
    $gdi = $it.how.StartsWith('gdi-')
    $probe = New-Object System.Drawing.Bitmap 8, 8
    $pg = [System.Drawing.Graphics]::FromImage($probe)
    if ($gdi) { $sz = [System.Windows.Forms.TextRenderer]::MeasureText($pg, $it.text, $font, (New-Object System.Drawing.Size 100000, 1000), $tf); $tw = $sz.Width; $th = $sz.Height }
    else { $sz = $pg.MeasureString($it.text, $font, 100000, $fmt); $tw = [int][math]::Ceiling($sz.Width); $th = [int][math]::Ceiling($sz.Height) }
    $pg.Dispose(); $probe.Dispose()
    $W = $tw + 2 * [int]$it.padX + 4
    $H = $th + 2 * [int]$it.padY + 2
    $bmp = New-Object System.Drawing.Bitmap $W, $H, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $bg = C $it.bg; $fg = C $it.fg
    $g.Clear($bg)
    $x = [int]$it.padX + 2; $y = [int]$it.padY + 1
    switch ($it.how) {
      'gdiplus-cleartype' { $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit }
      'gdiplus-aa' { $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias }
      'gdiplus-aa-grid' { $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit }
      'gdi-cleartype' { $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit }
      'gdi-aa' { $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit }
      'gdi-mono' { $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::SingleBitPerPixelGridFit }
    }
    if ($gdi) {
      [System.Windows.Forms.TextRenderer]::DrawText($g, $it.text, $font, (New-Object System.Drawing.Point $x, $y), $fg, $bg, $tf)
    } else {
      $brush = New-Object System.Drawing.SolidBrush $fg
      $g.DrawString($it.text, $font, $brush, [single]$x, [single]$y, $fmt)
      $brush.Dispose()
    }
    $g.Dispose(); $font.Dispose()
    $bmp.Save((Join-Path $out ($it.id + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    [void]$sb.AppendLine("$($it.id)`t$W`t$H")
  } catch {
    [void]$sb.AppendLine("$($it.id)`terror`t$($_.Exception.Message -replace '\s+', ' ')")
  }
}
$sb.ToString()
