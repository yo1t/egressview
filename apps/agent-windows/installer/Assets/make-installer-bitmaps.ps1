# Draws the installer's two bitmaps from the EgressView mark
# (design/icons/egressview-mark.svg), so the installer shows the product
# rather than WiX's stock artwork.
#
#   installer-dialog.bmp  493x312  Welcome and Finish: the mark and name on
#                                   the left panel; the right stays white,
#                                   because Windows Installer draws the
#                                   dialog's text over it.
#   installer-banner.bmp  493x58   The other pages: white, the mark at the
#                                   right; the page title is drawn on the left.
#
# The mark is geometry -- rounded bars and three dots on a rounded square --
# so it is drawn from the SVG's numbers here rather than scaled from the
# 128-pixel icon. Run it again if the mark changes; the output is committed.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$background = [System.Drawing.ColorTranslator]::FromHtml('#0b1424')
$blue = [System.Drawing.ColorTranslator]::FromHtml('#4d94ff')
$green = [System.Drawing.ColorTranslator]::FromHtml('#24d6a2')
$muted = [System.Drawing.ColorTranslator]::FromHtml('#8aa4c8')

function RoundedRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = 2 * $r
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    $path
}

# The SVG's 512-unit mark, drawn at ($left, $top) and $size pixels square.
function DrawMark($g, [float]$left, [float]$top, [float]$size) {
    $s = $size / 512
    $g.FillPath((New-Object System.Drawing.SolidBrush $background), (RoundedRect $left $top $size $size (114 * $s)))
    $bar = New-Object System.Drawing.SolidBrush $blue
    foreach ($r in @(@(86, 86, 80, 340), @(86, 86, 210, 80), @(86, 216, 130, 80), @(86, 346, 210, 80))) {
        $g.FillPath($bar, (RoundedRect ($left + $r[0] * $s) ($top + $r[1] * $s) ($r[2] * $s) ($r[3] * $s) (19 * $s)))
    }
    foreach ($c in @(@(386, 126, 40, $green), @(386, 256, 25, $blue), @(386, 386, 25, $blue))) {
        $radius = $c[2] * $s
        $g.FillEllipse((New-Object System.Drawing.SolidBrush $c[3]), ($left + $c[0] * $s - $radius), ($top + $c[1] * $s - $radius), 2 * $radius, 2 * $radius)
    }
}

function NewCanvas([int]$w, [int]$h) {
    $bitmap = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($bitmap)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([System.Drawing.Color]::White)
    @($bitmap, $g)
}

# Welcome / Finish. WiX_UI's text starts at 180 of 493 pixels; the panel stops
# short of it.
$bitmap, $g = NewCanvas 493 312
$panel = 164
$g.FillRectangle((New-Object System.Drawing.SolidBrush $background), 0, 0, $panel, 312)
DrawMark $g (($panel - 96) / 2) 72 96
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$g.DrawString('EgressView', (New-Object System.Drawing.Font('Segoe UI Semibold', 15, [System.Drawing.GraphicsUnit]::Pixel)),
    (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)), (New-Object System.Drawing.RectangleF(0, 182, $panel, 24)), $format)
$g.DrawString('Agent for Windows', (New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.GraphicsUnit]::Pixel)),
    (New-Object System.Drawing.SolidBrush $muted), (New-Object System.Drawing.RectangleF(0, 206, $panel, 20)), $format)
$g.Dispose()
$bitmap.Save((Join-Path $here 'installer-dialog.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$bitmap.Dispose()

# Banner. The title and description are drawn on the left, so the mark sits
# at the right edge.
$bitmap, $g = NewCanvas 493 58
DrawMark $g (493 - 44 - 10) 7 44
$g.Dispose()
$bitmap.Save((Join-Path $here 'installer-banner.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$bitmap.Dispose()
'wrote installer-dialog.bmp and installer-banner.bmp'
