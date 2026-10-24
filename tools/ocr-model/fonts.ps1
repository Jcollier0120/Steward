# Which of the model's characters each installed font draws itself (draw.py): GDI+ draws a box for a character its font
# lacks, where a browser would fall back to another font, so a line drawn by GDI or GDI+ goes only to fonts that have
# every character in it. Prepend $Chars = '<the characters>'. Prints {"<family>": "<the characters it lacks>", ...}.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName System.Drawing
$out = [ordered]@{}
foreach ($f in (New-Object System.Drawing.Text.InstalledFontCollection).Families) {
  $wf = New-Object System.Windows.Media.FontFamily $f.Name
  $gt = $null
  foreach ($t in $wf.GetTypefaces()) { if ($t.TryGetGlyphTypeface([ref]$gt)) { break } }
  if (-not $gt) { continue }
  $map = $gt.CharacterToGlyphMap
  $missing = New-Object System.Text.StringBuilder
  foreach ($ch in $Chars.ToCharArray()) { if (-not $map.ContainsKey([int]$ch)) { [void]$missing.Append($ch) } }
  $out[$f.Name] = $missing.ToString()
}
# ASCII only, as the kit's answers are (spec/OCR.md): a console's code page can't spoil \uXXXX.
$json = $out | ConvertTo-Json -Compress
[regex]::Replace($json, '[^\x20-\x7e]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
