using System.Globalization;
using System.Net;

namespace EgressView.Agent.Core;

internal sealed class DnsNameCache(TimeSpan? ttl = null, int capacity = 50_000)
{
    private readonly TimeSpan ttl = ttl ?? TimeSpan.FromMinutes(10);
    private readonly Dictionary<(int ProcessId, string Address), Entry> entries = [];
    private readonly object gate = new();
    private readonly IdnMapping idn = new();

    public long EventsSeen { get; private set; }
    public long CacheHits { get; private set; }
    public long CacheMisses { get; private set; }

    public void Observe(int processId, string? queryName, string? queryResults, DateTimeOffset observedAt)
    {
        if (processId <= 0 || NormalizeHostname(queryName) is not { } hostname || string.IsNullOrWhiteSpace(queryResults)) return;
        var addresses = queryResults.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(CanonicalAddress).Where(value => value is not null).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        if (addresses.Length == 0) return;
        lock (gate)
        {
            EventsSeen++;
            Prune(observedAt);
            if (entries.Count + addresses.Length > capacity)
                foreach (var key in entries.OrderBy(item => item.Value.ObservedAt).Take(entries.Count + addresses.Length - capacity).Select(item => item.Key).ToArray())
                    entries.Remove(key);
            foreach (var address in addresses) entries[(processId, address!)] = new(hostname, observedAt);
        }
    }

    /// Drops what has been learned so far.
    ///
    /// Someone turning destination-name reading off is asking for names not to
    /// be collected. Keeping a cache of the ones already collected and going
    /// on labelling new connections with them honours the letter of that and
    /// not the request: turning it off left new flows still being named, two
    /// in the first forty-six, from what the cache remembered.
    public void Forget()
    {
        lock (gate) entries.Clear();
    }

    public string? Resolve(int processId, string address, DateTimeOffset observedAt)
    {
        var canonical = CanonicalAddress(address);
        if (processId <= 0 || canonical is null) { lock (gate) CacheMisses++; return null; }
        lock (gate)
        {
            if (entries.TryGetValue((processId, canonical), out var entry) && observedAt - entry.ObservedAt <= ttl && observedAt >= entry.ObservedAt - TimeSpan.FromSeconds(2))
            {
                CacheHits++;
                return entry.Hostname;
            }
            CacheMisses++;
            return null;
        }
    }

    internal string? NormalizeHostname(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var trimmed = value.Trim().TrimEnd('.');
        if (!trimmed.Contains('.') || IPAddress.TryParse(trimmed, out _)) return null;
        try { return idn.GetAscii(trimmed).ToLowerInvariant(); }
        catch (ArgumentException) { return null; }
    }

    private void Prune(DateTimeOffset now)
    {
        foreach (var key in entries.Where(item => now - item.Value.ObservedAt > ttl).Select(item => item.Key).ToArray()) entries.Remove(key);
    }

    private static string? CanonicalAddress(string value)
    {
        if (!IPAddress.TryParse(value, out var address)) return null;
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6 && address.ScopeId != 0)
            address = new IPAddress(address.GetAddressBytes());
        return address.ToString();
    }

    private sealed record Entry(string Hostname, DateTimeOffset ObservedAt);
}
