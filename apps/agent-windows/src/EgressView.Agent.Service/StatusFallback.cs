using System.Text.Json.Nodes;

namespace EgressView.Agent.Service;

/// Answers a status request without waiting behind a long one (P3-140).
///
/// The store is guarded by one lock, and the 30-day analysis holds it for 8.8
/// seconds on the machine this was measured on. More pipe listeners let a
/// status request connect during that time, but it would still wait for the
/// lock, and the window asks every five seconds. So a status that cannot be
/// built within Budget is answered with the last one that was, marked as such.
///
/// Only a recent one. MaxAge is what keeps this from becoming the lie P3-161
/// was about -- a chip that kept saying "monitoring" because the last
/// successful poll said so. A lock held for a minute is not "busy" any more,
/// and the request then waits for the real answer and, if it does not come,
/// fails the way it should.
internal sealed class StatusFallback(TimeSpan budget, TimeSpan maxAge, Func<DateTimeOffset>? clock = null)
{
    public static readonly TimeSpan Budget = TimeSpan.FromMilliseconds(750);
    public static readonly TimeSpan MaxAge = TimeSpan.FromSeconds(60);

    private readonly Func<DateTimeOffset> now = clock ?? (() => DateTimeOffset.UtcNow);
    private readonly object gate = new();
    private (string Json, DateTimeOffset At)? last;

    public StatusFallback() : this(Budget, MaxAge) { }

    public string Get(Func<string> build)
    {
        var fresh = Task.Run(build);
        if (Task.WhenAny(fresh, Task.Delay(budget)).GetAwaiter().GetResult() == fresh)
            return Remember(fresh.GetAwaiter().GetResult());

        (string Json, DateTimeOffset At)? previous;
        lock (gate) previous = last;
        if (previous is { } known && now() - known.At <= maxAge)
            return Marked(known.Json, known.At);

        // Nothing recent enough to stand in for it: wait for the real one,
        // and let it fail if it fails.
        return Remember(fresh.GetAwaiter().GetResult());
    }

    private string Remember(string json)
    {
        lock (gate) last = (json, now());
        return json;
    }

    /// The last status, saying it is the last one and when it was taken, so a
    /// reader can tell it from a fresh one without the window having to.
    private static string Marked(string json, DateTimeOffset at)
    {
        var node = JsonNode.Parse(json)!.AsObject();
        node["servedWhileBusy"] = true;
        node["statusAt"] = at;
        return node.ToJsonString();
    }
}
