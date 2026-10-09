namespace EgressView.Agent.Service;

/// One computation per question, however many callers ask it at once (P3-106).
///
/// Measured on 2026-09-27: a window showing thirty days was killed, its
/// analysis, globe and threat reads went on in the service with no one to
/// answer, and the window opened in its place asked the same three again.
/// Six heavy reads queued on the store's lock, the four listeners were all
/// taken, and status could not connect for up to thirty seconds. The second
/// window's questions were the first window's questions. Asked while the
/// first answer is still being worked out, they now wait for it rather than
/// starting their own.
///
/// Only for reads whose answer depends on nothing but the key. An answer
/// computed a few seconds before the second caller asked is the one it would
/// have got.
internal sealed class InFlightReads
{
    private readonly object gate = new();
    private readonly Dictionary<string, Task<object?>> running = new(StringComparer.Ordinal);

    public T Run<T>(string key, Func<T> read)
    {
        Task<object?> task;
        lock (gate)
        {
            if (!running.TryGetValue(key, out task!))
            {
                task = Task.Run(() => (object?)read());
                running[key] = task;
                // Forgotten once it ends, so a later question computes a
                // later answer. Not on the caller's thread: the caller may
                // already have gone.
                task.ContinueWith(_ => { lock (gate) running.Remove(key); }, TaskScheduler.Default);
            }
        }
        return (T)task.GetAwaiter().GetResult()!;
    }

    public int Running { get { lock (gate) return running.Count; } }
}
