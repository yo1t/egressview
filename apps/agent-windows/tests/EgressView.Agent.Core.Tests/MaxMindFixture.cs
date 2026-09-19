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

    /// A record shaped like a real one, not like the reader.
    ///
    /// The published databases put "continent" and "registered_country"
    /// beside "country", and a boolean inside the country map. The reader has
    /// to walk past all of it to reach the one field it wants, so the fixture
    /// writes all of it. An earlier version wrote only what the reader already
    /// handled, which is how a decoder that could not skip a boolean passed
    /// every test and then failed on the first real download.
    private static byte[] CountryRecord(string code)
    {
        var data = new List<byte> { 0xE3 };          // map, 3 pairs
        data.AddRange(Utf8("continent"));
        data.Add(0xE2);                              // map, 2 pairs
        data.AddRange(Utf8("code"));
        data.AddRange(Utf8("AS"));
        data.AddRange(Utf8("geoname_id"));
        data.AddRange(Unsigned(6_255_147));

        data.AddRange(Utf8("country"));
        data.Add(0xE3);                              // map, 3 pairs
        data.AddRange(Utf8("is_in_european_union"));
        data.AddRange(Boolean(true));
        data.AddRange(Utf8("iso_code"));
        data.AddRange(Utf8(code));
        data.AddRange(Utf8("names"));
        data.Add(0xE1);                              // map, 1 pair
        data.AddRange(Utf8("en"));
        data.AddRange(Utf8("Somewhere"));

        data.AddRange(Utf8("registered_country"));
        data.Add(0xE1);                              // map, 1 pair
        data.AddRange(Utf8("iso_code"));
        data.AddRange(Utf8("ZZ"));
        return data.ToArray();
    }

    /// The boolean carries its value in the control byte and occupies no
    /// bytes of its own, so a reader that treats the length as a byte count
    /// walks one byte too far.
    private static byte[] Boolean(bool value) => [(byte)(value ? 0x01 : 0x00), 14 - 7];

    /// An array's length is a count of elements, not a count of bytes. A
    /// reader that skips "length" bytes lands in the middle of the next value
    /// and every field after it is read from the wrong offset.
    private static byte[] Array(params byte[][] elements)
    {
        var data = new List<byte>();
        if (elements.Length >= 29) throw new InvalidOperationException("The test builder only writes short arrays.");
        data.Add((byte)elements.Length);              // extended: length in the control byte
        data.Add(11 - 7);                             // array
        foreach (var element in elements) data.AddRange(element);
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
        // Nine keys, in the order and of the kinds the published databases
        // carry. "languages" is an array and "description" is a map; both sit
        // before the version numbers, so a reader that mis-skips either one
        // reads the rest of this map from the wrong place.
        var data = new List<byte> { 0xE9 };           // map, 9 pairs
        void Pair(string key, byte[] value) { data.AddRange(Utf8(key)); data.AddRange(value); }
        // Alphabetical, as the published databases write it. The order is what
        // makes the array matter: "description" and "languages" sit before
        // "node_count" and "record_size", so a reader that mis-skips either one
        // reads the two fields it cannot do without from the wrong offset. A
        // fixture that put them last hid exactly this.
        Pair("binary_format_major_version", Unsigned(2));
        Pair("binary_format_minor_version", Unsigned(0));
        Pair("build_epoch", Unsigned(buildEpoch));
        Pair("database_type", Utf8(databaseType));
        Pair("description", DescriptionMap(databaseType));
        Pair("ip_version", Unsigned((ulong)ipVersion));
        Pair("languages", Array(Utf8("en"), Utf8("ja"), Utf8("pt-BR")));
        Pair("node_count", Unsigned(nodeCount));
        Pair("record_size", Unsigned(24));
        return data.ToArray();
    }

    private static byte[] DescriptionMap(string databaseType)
    {
        var data = new List<byte> { 0xE1 };           // map, 1 pair
        data.AddRange(Utf8("en"));
        data.AddRange(Utf8(databaseType));
        return data.ToArray();
    }
}
