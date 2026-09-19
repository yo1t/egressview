// Draws the Windows icons from design/icons, the same artwork the Mac builds
// from, so the two agents are recognisably one product.
//
// scripts/build-agent-icons.sh is the macOS half and needs sips and iconutil.
// This is the Windows half. Both read the same SVGs; neither owns the artwork.
// The geometry below is transcribed from those files rather than rasterised,
// because adding an SVG rasteriser to this repository to draw eleven
// rectangles and three circles would be the larger liability -- and the
// transcription is checked against the source by the test beside it.
//
// Run: dotnet run --project tools/make-icons
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

// design/icons/egressview-mark.svg, on its 512 viewBox.
var plate = ColorTranslator.FromHtml("#0b1424");
var ink = ColorTranslator.FromHtml("#4d94ff");
var liveGreen = ColorTranslator.FromHtml("#24d6a2");

// The Mac's menu bar images are template images: macOS paints them one colour,
// so they tell the states apart by shape -- a filled dot, a hollow ring, a
// ring around a dot. The Windows tray does not do that, and a black-only icon
// would vanish on a dark taskbar, so these keep the plate and the colour.
//
// The shapes are still the Mac's. Matching them is what makes the two agents
// read as the same product; the colour is the channel Windows gives back.
(string Name, DotShape Shape, Color Colour, bool Small)[] icons =
[
    ("egressview", DotShape.Filled, liveGreen, false),
    ("tray-monitoring", DotShape.Filled, liveGreen, true),
    ("tray-stopped", DotShape.Ring, ColorTranslator.FromHtml("#8a93a0"), true),
    // The Mac groups "needs approval", "needs a restart" and "failed" into one
    // attention image. These are the two Windows states that fall under it.
    ("tray-attention", DotShape.RingAroundDot, ColorTranslator.FromHtml("#f5a524"), true),
    ("tray-unavailable", DotShape.RingAroundDot, ColorTranslator.FromHtml("#e4443b"), true),
];

// Rendered at each size rather than scaled from one: a 16px downscale of a
// 256px drawing is a smear, which is why the small mark exists at all.
int[] appSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
int[] traySizes = [16, 20, 24, 32, 40, 48, 64];

var assets = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..",
    "src", "EgressView.Agent.Ui", "Assets"));
Directory.CreateDirectory(assets);

foreach (var (name, shape, colour, trayOnly) in icons)
{
    var sizes = trayOnly ? traySizes : appSizes;
    // egressview-mark-small.svg drops the two quiet dots below 33px and grows
    // the live one from r=40 to r=46, so it still separates from the E.
    var frames = sizes.Select(size => Render(size, shape, colour, simplify: trayOnly || size <= 32)).ToArray();
    var path = Path.Combine(assets, name + ".ico");
    WriteIcon(path, frames);
    foreach (var frame in frames) frame.Dispose();
    Console.WriteLine($"wrote {Path.GetFileName(path)}  ({string.Join(", ", sizes)})");
}

Bitmap Render(int size, DotShape shape, Color dot, bool simplify)
{
    var bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb);
    using var g = Graphics.FromImage(bitmap);
    g.SmoothingMode = SmoothingMode.AntiAlias;
    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
    g.Clear(Color.Transparent);

    var u = size / 512f;                       // the SVG viewBox
    float S(float v) => v * u;

    using (var plateBrush = new SolidBrush(plate))
    using (var shell = Rounded(new RectangleF(0, 0, size, size), S(114)))
        g.FillPath(plateBrush, shell);

    using (var letter = new SolidBrush(ink))
    {
        Bar(g, letter, S(86), S(86), S(80), S(340), S(19));
        Bar(g, letter, S(86), S(86), S(210), S(80), S(19));
        Bar(g, letter, S(86), S(216), S(130), S(80), S(19));
        Bar(g, letter, S(86), S(346), S(210), S(80), S(19));
        if (!simplify)
        {
            Circle(g, letter, S(386), S(256), S(25));
            Circle(g, letter, S(386), S(386), S(25));
        }
    }

    var cx = S(386);
    var cy = S(126);
    using var dotBrush = new SolidBrush(dot);
    using var pen = new Pen(dot);
    switch (shape)
    {
        case DotShape.Filled:
            Circle(g, dotBrush, cx, cy, simplify ? S(46) : S(40));
            break;
        case DotShape.Ring:
            pen.Width = S(24);
            g.DrawEllipse(pen, cx - S(34), cy - S(34), S(68), S(68));
            break;
        case DotShape.RingAroundDot:
            Circle(g, dotBrush, cx, cy, S(30));
            pen.Width = S(18);
            g.DrawEllipse(pen, cx - S(62), cy - S(62), S(124), S(124));
            break;
    }
    return bitmap;
}

static void Circle(Graphics g, Brush brush, float cx, float cy, float r) =>
    g.FillEllipse(brush, cx - r, cy - r, r * 2, r * 2);

static void Bar(Graphics g, Brush brush, float x, float y, float width, float height, float radius)
{
    using var path = Rounded(new RectangleF(x, y, width, height), Math.Min(radius, Math.Min(width, height) / 2));
    g.FillPath(brush, path);
}

static GraphicsPath Rounded(RectangleF bounds, float radius)
{
    var path = new GraphicsPath();
    if (radius <= 0.01f) { path.AddRectangle(bounds); return path; }
    var d = radius * 2;
    path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
    path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
    path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
    path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
    path.CloseFigure();
    return path;
}

/// Writes the container by hand.
///
/// System.Drawing can read an .ico and save one image; it cannot assemble
/// several sizes into one file.
///
/// Each entry below 256 is a device-independent bitmap, not a PNG. Explorer
/// reads PNG entries happily, but System.Drawing.Icon -- which is what the
/// tray and the window use to load these -- does not, and a file it cannot
/// read is a file with no icon in it. Written as PNG first, and every size
/// failed to load; 256 stays PNG because a raw one is a megabyte.
static void WriteIcon(string path, Bitmap[] frames)
{
    var payloads = frames.Select(frame => frame.Width >= 256 ? Png(frame) : Dib(frame)).ToArray();

    using var file = File.Create(path);
    using var writer = new BinaryWriter(file);
    writer.Write((ushort)0);
    writer.Write((ushort)1);                    // type: icon
    writer.Write((ushort)frames.Length);
    var offset = 6 + 16 * frames.Length;
    for (var index = 0; index < frames.Length; index++)
    {
        var size = frames[index].Width;
        writer.Write((byte)(size >= 256 ? 0 : size));   // 0 means 256
        writer.Write((byte)(size >= 256 ? 0 : size));
        writer.Write((byte)0);
        writer.Write((byte)0);
        writer.Write((ushort)1);                // colour planes
        writer.Write((ushort)32);               // bits per pixel
        writer.Write(payloads[index].Length);
        writer.Write(offset);
        offset += payloads[index].Length;
    }
    foreach (var payload in payloads) writer.Write(payload);
}

static byte[] Png(Bitmap frame)
{
    using var buffer = new MemoryStream();
    frame.Save(buffer, ImageFormat.Png);
    return buffer.ToArray();
}

/// A BITMAPINFOHEADER, the pixels bottom-up in BGRA, and the AND mask.
///
/// The header lies about the height on purpose: the format wants the colour
/// rows and the mask rows counted together, and readers rely on it. The mask
/// itself is left clear -- the alpha channel already carries the shape -- but
/// it has to be there, one bit per pixel, rows padded to four bytes.
static byte[] Dib(Bitmap frame)
{
    var width = frame.Width;
    var height = frame.Height;
    using var buffer = new MemoryStream();
    using var writer = new BinaryWriter(buffer);
    writer.Write(40);                           // header size
    writer.Write(width);
    writer.Write(height * 2);                   // colour rows plus mask rows
    writer.Write((ushort)1);
    writer.Write((ushort)32);
    writer.Write(0);                            // BI_RGB
    writer.Write(width * height * 4);
    writer.Write(0); writer.Write(0); writer.Write(0); writer.Write(0);

    for (var y = height - 1; y >= 0; y--)
        for (var x = 0; x < width; x++)
        {
            var pixel = frame.GetPixel(x, y);
            writer.Write(pixel.B);
            writer.Write(pixel.G);
            writer.Write(pixel.R);
            writer.Write(pixel.A);
        }

    var maskRow = (width + 31) / 32 * 4;
    writer.Write(new byte[maskRow * height]);
    return buffer.ToArray();
}

internal enum DotShape { Filled, Ring, RingAroundDot }
