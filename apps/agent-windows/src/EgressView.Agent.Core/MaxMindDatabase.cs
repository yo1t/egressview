using System.Net;

namespace EgressView.Agent.Core;

public enum MaxMindFailureKind { Unreadable, NoMetadata, MalformedMetadata, UnsupportedRecordSize, CorruptTree }

public sealed class MaxMindException(MaxMindFailureKind kind, string message) : Exception(message)
{
    public MaxMindFailureKind Kind { get; } = kind;
}

/// What the file says about itself.
///
/// <c>BuildEpoch</c> is the part that matters operationally: the licence
/// requires moving to a new build and destroying the old one within thirty
/// days, so the Agent has to be able to say how old its copy is.
public sealed record MaxMindMetadata(
    uint NodeCount, int RecordSize, int IpVersion, string DatabaseType,
    ulong BuildEpoch, ushort MajorVersion, ushort MinorVersion)
{
    public DateTimeOffset BuiltAt => DateTimeOffset.FromUnixTimeSeconds((long)BuildEpoch);
    public TimeSpan Age(DateTimeOffset now) => now - BuiltAt;
}

/// Reads a MaxMind DB file well enough to answer "which country is this
/// address in", and nothing more.
///
/// The point is to stop asking anyone. Without a Hub the Windows Agent has no
/// country at all today; with a Hub it has one because the Hub was asked. A
/// table on this PC ends both: the question never leaves the machine.
///
/// Only the country is read. The globe draws arcs to coordinates and the
/// country database has none; that stays with the Hub, and the limit is stated
/// rather than papered over.
///
/// The format is MaxMind DB 2.0, whose specification is public. Three parts,
/// in this order: a binary search tree over the address bits, sixteen zero
/// bytes, and a data section. The metadata sits at the end behind a marker.
public sealed class MaxMindDatabase
{
    private static readonly byte[] MetadataMarker =
        [0xAB, 0xCD, 0xEF, .. "MaxMind.com"u8];

    /// The specification puts the metadata within the last 128 KiB.
    private const int MetadataSearchWindow = 128 * 1024;

    private readonly byte[] bytes;
    private readonly int searchTreeSize;
    private readonly int dataSectionStart;

    /// Where an IPv4 lookup starts in an IPv6 tree: the node reached by
    /// walking ninety-six zero bits. Found once, because every IPv4 lookup
    /// would otherwise repeat the same ninety-six steps.
    private readonly uint ipv4StartNode;

    public MaxMindMetadata Metadata { get; }

    public MaxMindDatabase(byte[] bytes)
    {
        this.bytes = bytes ?? throw new ArgumentNullException(nameof(bytes));
        Metadata = ReadMetadata(bytes);
        if (Metadata.RecordSize is not (24 or 28 or 32))
            throw new MaxMindException(MaxMindFailureKind.UnsupportedRecordSize,
                $"Record size {Metadata.RecordSize} is not one this reader understands.");
        searchTreeSize = (int)(Metadata.NodeCount * (uint)Metadata.RecordSize * 2 / 8);
        dataSectionStart = searchTreeSize + 16;
        if (dataSectionStart > bytes.Length)
            throw new MaxMindException(MaxMindFailureKind.CorruptTree,
                "The search tree is longer than the file that holds it.");
        ipv4StartNode = Metadata.IpVersion == 6 ? FindIpv4StartNode() : 0;
    }

    public static MaxMindDatabase Open(string path)
    {
        try { return new MaxMindDatabase(File.ReadAllBytes(path)); }
        catch (MaxMindException) { throw; }
        catch (Exception)
        {
            throw new MaxMindException(MaxMindFailureKind.Unreadable, $"Could not read {Path.GetFileName(path)}.");
        }
    }

    /// <returns>The ISO country code, or null when the table has no answer.</returns>
    public string? CountryCode(string address)
    {
        var bits = AddressBits(address);
        if (bits is null) return null;
        var node = bits.Length == 32 && Metadata.IpVersion == 6 ? ipv4StartNode : 0u;
        foreach (var bit in bits)
        {
            if (node >= Metadata.NodeCount) break;
            node = ReadRecord(node, bit);
        }
        // Equal to the node count means the walk fell off the tree: no entry
        // covers this address, which is an answer rather than a fault.
        if (node <= Metadata.NodeCount) return null;
        var offset = (int)(node - Metadata.NodeCount - 16);
        if (offset < 0 || dataSectionStart + offset >= bytes.Length) return null;
        return ReadCountryCode(dataSectionStart + offset);
    }

    /// The address as a bit array, or null when it is not an address this
    /// reader can place.
    internal static byte[]? AddressBits(string address)
    {
        if (!IPAddress.TryParse(address, out var parsed)) return null;
        var octets = parsed.GetAddressBytes();
        var bits = new byte[octets.Length * 8];
        for (var index = 0; index < octets.Length; index++)
            for (var bit = 0; bit < 8; bit++)
                bits[index * 8 + bit] = (byte)((octets[index] >> (7 - bit)) & 1);
        return bits;
    }

    private uint FindIpv4StartNode()
    {
        var node = 0u;
        for (var step = 0; step < 96 && node < Metadata.NodeCount; step++) node = ReadRecord(node, 0);
        return node;
    }

    private uint ReadRecord(uint node, byte bit)
    {
        var baseOffset = (int)(node * (uint)Metadata.RecordSize * 2 / 8);
        return Metadata.RecordSize switch
        {
            24 => Read24(baseOffset + bit * 3),
            28 => Read28(baseOffset, bit),
            _ => Read32(baseOffset + bit * 4),
        };
    }

    private uint Read24(int offset)
    {
        Require(offset + 3);
        return (uint)((bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2]);
    }

    private uint Read32(int offset)
    {
        Require(offset + 4);
        return ((uint)bytes[offset] << 24) | ((uint)bytes[offset + 1] << 16) |
               ((uint)bytes[offset + 2] << 8) | bytes[offset + 3];
    }

    /// The 28-bit layout splits a shared middle byte: the high nibble belongs
    /// to the left record and the low nibble to the right.
    private uint Read28(int baseOffset, byte bit)
    {
        Require(baseOffset + 7);
        if (bit == 0)
            return ((uint)(bytes[baseOffset + 3] >> 4) << 24) |
                   ((uint)bytes[baseOffset] << 16) | ((uint)bytes[baseOffset + 1] << 8) | bytes[baseOffset + 2];
        return ((uint)(bytes[baseOffset + 3] & 0x0F) << 24) |
               ((uint)bytes[baseOffset + 4] << 16) | ((uint)bytes[baseOffset + 5] << 8) | bytes[baseOffset + 6];
    }

    private void Require(int end)
    {
        if (end > bytes.Length)
            throw new MaxMindException(MaxMindFailureKind.CorruptTree, "The tree points past the end of the file.");
    }

    private string? ReadCountryCode(int offset)
    {
        var decoder = new MaxMindDecoder(bytes, dataSectionStart);
        return decoder.ReadCountryIsoCode(offset);
    }

    private static MaxMindMetadata ReadMetadata(byte[] bytes)
    {
        var searchFrom = Math.Max(0, bytes.Length - MetadataSearchWindow);
        var start = -1;
        for (var index = bytes.Length - MetadataMarker.Length; index >= searchFrom; index--)
        {
            var matched = true;
            for (var offset = 0; offset < MetadataMarker.Length; offset++)
                if (bytes[index + offset] != MetadataMarker[offset]) { matched = false; break; }
            if (matched) { start = index + MetadataMarker.Length; break; }
        }
        if (start < 0) throw new MaxMindException(MaxMindFailureKind.NoMetadata, "No MaxMind metadata marker in this file.");

        // The metadata section is its own little data section: offsets inside
        // it are relative to where it begins, not to the file's data section.
        var decoder = new MaxMindDecoder(bytes, start);
        var map = decoder.ReadMap(start)
            ?? throw new MaxMindException(MaxMindFailureKind.MalformedMetadata, "The metadata is not a map.");
        uint Number(string key) => map.TryGetValue(key, out var value) && value is ulong number ? (uint)number : 0;
        string Text(string key) => map.TryGetValue(key, out var value) && value is string text ? text : string.Empty;
        var nodeCount = Number("node_count");
        var recordSize = (int)Number("record_size");
        if (nodeCount == 0 || recordSize == 0)
            throw new MaxMindException(MaxMindFailureKind.MalformedMetadata, "The metadata has no node count or record size.");
        return new MaxMindMetadata(nodeCount, recordSize, (int)Number("ip_version"), Text("database_type"),
            map.TryGetValue("build_epoch", out var epoch) && epoch is ulong built ? built : 0,
            (ushort)Number("binary_format_major_version"), (ushort)Number("binary_format_minor_version"));
    }
}
