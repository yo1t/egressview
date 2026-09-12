namespace EgressView.Agent.Core;

/// Folding events into conversations, the same way the store does.
///
/// The log can be read as events or as conversations, and both readings must
/// describe the same traffic. The store already folds one into the other when
/// it writes; doing it again here lets the screen advance from a stream of
/// events without asking the store to rebuild the whole page.
///
/// The rule has to be the store's rule, not a plausible one. `flow_key` drops
/// the remote address for UDP, so a fold keyed on the full five-tuple would
/// split a conversation the store keeps whole, and the two readings would
/// disagree about how many conversations there are.
public static class ObservationFold
{
    /// <param name="conversations">The page as the store last reported it.</param>
    /// <param name="events">Observations that arrived after that page was read.</param>
    /// <param name="limit">How many rows the page holds.</param>
    public static IReadOnlyList<RecentFlow> Apply(
        IReadOnlyList<RecentFlow> conversations, IReadOnlyList<RecentFlow> events, int limit)
    {
        if (events.Count == 0) return conversations;
        var byKey = new Dictionary<string, RecentFlow>(StringComparer.Ordinal);
        var order = new List<string>();
        foreach (var row in conversations)
        {
            var key = Key(row);
            if (byKey.TryAdd(key, row)) order.Add(key);
        }

        foreach (var observation in events)
        {
            var key = Key(observation);
            if (!byKey.TryGetValue(key, out var existing))
            {
                byKey[key] = observation;
                order.Add(key);
                continue;
            }
            byKey[key] = existing with
            {
                // The store keeps the first sighting and takes the newest as
                // the last, and sums bytes only over what it actually measured.
                LastSeen = observation.LastSeen > existing.LastSeen ? observation.LastSeen : existing.LastSeen,
                FirstSeen = observation.FirstSeen < existing.FirstSeen ? observation.FirstSeen : existing.FirstSeen,
                BytesSent = Add(existing.BytesSent, observation.BytesSent),
                BytesReceived = Add(existing.BytesReceived, observation.BytesReceived),
                // Enrichment lands on the conversation, so an event that does
                // not carry it must not erase what the conversation knows.
                ProcessName = existing.ProcessName ?? observation.ProcessName,
                RemoteHostname = existing.RemoteHostname ?? observation.RemoteHostname,
                CountryCode = existing.CountryCode ?? observation.CountryCode,
                InterfaceId = existing.InterfaceId ?? observation.InterfaceId,
            };
        }

        return order.Select(key => byKey[key])
            .OrderByDescending(row => row.LastSeen)
            .ThenBy(Key, StringComparer.Ordinal)
            .Take(limit)
            .ToArray();
    }

    private static string Key(RecentFlow row) =>
        StartupSnapshot.FlowKey(row.Protocol, row.LocalAddress, row.LocalPort, row.RemoteAddress, row.RemotePort, row.ProcessId);

    /// A conversation that has never had a measurement stays unmeasured until
    /// one arrives: summing a null as zero would report a measured zero.
    private static long? Add(long? running, long? arriving) =>
        running is null ? arriving : arriving is null ? running : running + arriving;
}
