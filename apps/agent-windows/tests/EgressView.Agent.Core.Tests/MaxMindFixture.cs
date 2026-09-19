using EgressView.Agent.Core;

namespace EgressView.Agent.Core.Tests;

/// Builds a MaxMind DB 2.0 file from a handful of prefixes.
///
/// Written from the published specification rather than borrowed from the
/// reader, so the reader is checked against the format and not against a copy
/// of itself. It supports only what these tests need: 24-bit records, one data
/// payload per prefix, no pointers in the tree's own data.
internal static class MaxMindFixture
{
    internal sealed record Entry(byte[] Bits, string CountryCode);

    /// The database the tests share: three prefixes, IPv4, one build date.
    internal static byte[] CountryDatabase(ulong buildEpoch = 1_757_000_000) => Build(
    [
        new Entry(AddressBits("1.2.0.0", 16), "JP"),
        new Entry(AddressBits("8.8.8.0", 24), "US"),
        new Entry(AddressBits("203.0.113.0", 24), "AU"),
    ], ipVersion: 4, buildEpoch: buildEpoch);

    internal static byte[] AddressBits(string address, int prefix) =>
        MaxMindDatabase.AddressBits(address)!.Take(prefix).ToArray();

    private sealed class Node
    {
        internal readonly Node?[] Children = [null, null];
        internal int? DataIndex;
        internal int Index;
    }

    internal static byte[] Build(Entry[] entries, int ipVersion,
        string databaseType = "GeoLite2-Country", ulong buildEpoch = 1_757_000_000)
    {
        var root = new Node();
        var payloads = new List<string>();
        foreach (var entry in entries)
        {
            var node = root;
            foreach (var bit in entry.Bits)
            {
                node.Children[bit] ??= new Node();
                node = node.Children[bit]!;
            }
            var existing = payloads.IndexOf(entry.CountryCode);
            if (existing >= 0) node.DataIndex = existing;
            else { payloads.Add(entry.CountryCode); node.DataIndex = payloads.Count - 1; }
        }

        // Interior nodes are numbered breadth-first. Leaves carrying data are
        // not nodes: they are records pointing into the data section.
        var ordered = new List<Node>();
        var queue = new Queue<Node>();
        queue.Enqueue(root);
        while (queue.Count > 0)
        {
            var node = queue.Dequeue();
            node.Index = ordered.Count;
            ordered.Add(node);
            foreach (var child in node.Children)
                if (child is not null && child.DataIndex is null) queue.Enqueue(child);
        }
        var nodeCount = (uint)ordered.Count;

        var data = new List<byte>();
        var payloadOffsets = new List<int>();
        foreach (var code in payloads)
        {
            payloadOffsets.Add(data.Count);
            data.AddRange(CountryRecord(code));
        }

        var tree = new List<byte>();
        foreach (var node in ordered)
            for (var side = 0; side < 2; side++)
            {
                uint value;
                var child = node.Children[side];
                if (child is null) value = nodeCount;                                  // nothing here
                else if (child.DataIndex is { } index) value = (uint)payloadOffsets[index] + nodeCount + 16;
                else value = (uint)child.Index;
                tree.Add((byte)((value >> 16) & 0xFF));
                tree.Add((byte)((value >> 8) & 0xFF));
                tree.Add((byte)(value & 0xFF));
            }

        var file = new List<byte>(tree);
        file.AddRange(new byte[16]);
        file.AddRange(data);
        file.AddRange([0xAB, 0xCD, 0xEF]);
        file.AddRange("MaxMind.com"u8.ToArray());
        file.AddRange(Metadata(nodeCount, ipVersion, databaseType, buildEpoch));
        return file.ToArray();
    }

    /// <c>{"country": {"iso_code": "XX"}}</c>
    private static byte[] CountryRecord(string code)
    {
        var data = new List<byte> { 0xE1 };          // map, 1 pair
        data.AddRange(Utf8("country"));
        data.Add(0xE1);                              // map, 1 pair
        data.AddRange(Utf8("iso_code"));
        data.AddRange(Utf8(code));
        return data.ToArray();
    }

    private static byte[] Utf8(string value)
    {
        var utf8 = System.Text.Encoding.UTF8.GetBytes(value);
        if (utf8.Length >= 29) throw new InvalidOperationException("The test builder only writes short strings.");
        return [(byte)(0x40 | utf8.Length), .. utf8];
    }

    private static byte[] Unsigned(ulong value)
    {
        var bytes = new List<byte>();
        var remaining = value;
        while (remaining > 0) { bytes.Insert(0, (byte)(remaining & 0xFF)); remaining >>= 8; }
        return [(byte)(0xC0 | bytes.Count), .. bytes];   // uint32, variable length
    }

    private static byte[] Metadata(uint nodeCount, int ipVersion, string databaseType, ulong buildEpoch)
    {
        var data = new List<byte> { 0xE7 };           // map, 7 pairs
        void Pair(string key, byte[] value) { data.AddRange(Utf8(key)); data.AddRange(value); }
        Pair("node_count", Unsigned(nodeCount));
        Pair("record_size", Unsigned(24));
        Pair("ip_version", Unsigned((ulong)ipVersion));
        Pair("database_type", Utf8(databaseType));
        Pair("build_epoch", Unsigned(buildEpoch));
        Pair("binary_format_major_version", Unsigned(2));
        Pair("binary_format_minor_version", Unsigned(0));
        return data.ToArray();
    }
}
