using System.IO.Compression;
using System.Text;

namespace EgressView.Agent.Core;

public static class DiagnosticsBundle
{
    public static void Create(string destination, string diagnosticsJson)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(destination))!);
        using var archive = ZipFile.Open(destination, ZipArchiveMode.Create);
        Write(archive, "diagnostics.json", diagnosticsJson);
        Write(archive, "README.txt", "Privacy-safe EgressView Agent diagnostics. This bundle excludes endpoints, process names, credentials, raw observations, and the SQLite database.\r\n");
    }

    private static void Write(ZipArchive archive, string name, string content)
    {
        using var stream = archive.CreateEntry(name, CompressionLevel.Optimal).Open();
        using var writer = new StreamWriter(stream, new UTF8Encoding(false));
        writer.Write(content);
    }
}
