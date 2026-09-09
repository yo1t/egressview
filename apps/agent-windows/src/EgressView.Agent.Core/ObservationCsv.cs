using System.Globalization;
using System.Text;

namespace EgressView.Agent.Core;

/// <summary>Portable RFC 4180 export of the exact local rows shown by the Windows Agent.</summary>
public static class ObservationCsv
{
    public static readonly string[] Columns =
    [
        "first_observed_at", "last_observed_at", "process_name", "process_id",
        "protocol", "local_address", "local_port", "remote_address", "remote_hostname", "remote_port", "country_code",
        "bytes_in", "bytes_out", "layer", "collector"
    ];

    public static string Export(IEnumerable<RecentFlow> observations)
    {
        var output = new StringBuilder();
        output.Append(Header);
        AppendRows(output, observations);
        return output.ToString();
    }

    public static string Header => string.Join(',', Columns) + "\r\n";

    public static string ExportRows(IEnumerable<RecentFlow> observations)
    {
        var output = new StringBuilder();
        AppendRows(output, observations);
        return output.ToString();
    }

    private static void AppendRows(StringBuilder output, IEnumerable<RecentFlow> observations)
    {
        foreach (var row in observations)
        {
            var fields = new[]
            {
                row.FirstSeen.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture),
                row.LastSeen.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture),
                row.ProcessName ?? string.Empty,
                row.ProcessId.ToString(CultureInfo.InvariantCulture),
                row.Protocol,
                row.LocalAddress,
                row.LocalPort.ToString(CultureInfo.InvariantCulture),
                row.RemoteAddress,
                row.RemoteHostname ?? string.Empty,
                row.RemotePort.ToString(CultureInfo.InvariantCulture),
                row.CountryCode ?? string.Empty,
                row.BytesReceived?.ToString(CultureInfo.InvariantCulture) ?? string.Empty,
                row.BytesSent?.ToString(CultureInfo.InvariantCulture) ?? string.Empty,
                row.Layer.ToString(),
                row.Origin,
            };
            output.AppendJoin(',', fields.Select(Field)).Append("\r\n");
        }
    }

    public static string SuggestedFileName(DateTimeOffset from, DateTimeOffset to) =>
        $"egressview-{from.LocalDateTime:yyyyMMdd-HHmm}-to-{to.LocalDateTime:yyyyMMdd-HHmm}.csv";

    private static string Field(string value) =>
        value.IndexOfAny([',', '"', '\r', '\n']) < 0 ? value : $"\"{value.Replace("\"", "\"\"")}\"";
}
