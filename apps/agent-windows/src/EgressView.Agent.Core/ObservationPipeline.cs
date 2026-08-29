using System.Threading.Channels;

namespace EgressView.Agent.Core;

public sealed class ObservationPipeline : IAsyncDisposable
{
    private readonly ObservationStore store;
    private readonly Channel<NetworkObservation> channel;
    private readonly CancellationTokenSource stop = new();
    private readonly Task writer;
    private readonly int batchSize;
    private long accepted, persisted, queueFullDrops, persistenceFailures;
    private long flushedQueueFullDrops, flushedPersistenceFailures;
    private long lastObservedTicks, lastPersistedTicks;

    public ObservationPipeline(ObservationStore store, int capacity = 65_536, int batchSize = 256)
    {
        this.store = store;
        QueueCapacity = capacity;
        this.batchSize = batchSize;
        channel = Channel.CreateBounded<NetworkObservation>(new BoundedChannelOptions(capacity)
        {
            // Wait makes TryWrite return false when full, so every drop is observable.
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = true,
            SingleWriter = false,
        });
        writer = Task.Run(WriteLoopAsync);
    }

    public int QueueCapacity { get; }

    public bool TrySubmit(NetworkObservation observation)
    {
        if (!channel.Writer.TryWrite(observation))
        {
            Interlocked.Increment(ref queueFullDrops);
            return false;
        }
        Interlocked.Increment(ref accepted);
        Interlocked.Exchange(ref lastObservedTicks, observation.ObservedAt.UtcTicks);
        return true;
    }

    public CollectorSnapshot Snapshot() => new(
        persistenceFailures == 0 ? "healthy" : "degraded",
        Interlocked.Read(ref accepted), Interlocked.Read(ref persisted),
        Interlocked.Read(ref queueFullDrops), Interlocked.Read(ref persistenceFailures),
        FromTicks(Interlocked.Read(ref lastObservedTicks)), FromTicks(Interlocked.Read(ref lastPersistedTicks)), QueueCapacity);

    private async Task WriteLoopAsync()
    {
        var batch = new List<NetworkObservation>(batchSize);
        try
        {
            await foreach (var item in channel.Reader.ReadAllAsync(stop.Token))
            {
                batch.Add(item);
                while (batch.Count < batchSize && channel.Reader.TryRead(out var next)) batch.Add(next);
                try
                {
                    store.WriteBatch(batch);
                    Interlocked.Add(ref persisted, batch.Count);
                    Interlocked.Exchange(ref lastPersistedTicks, DateTimeOffset.UtcNow.UtcTicks);
                    FlushCounters();
                }
                catch
                {
                    Interlocked.Increment(ref persistenceFailures);
                }
                batch.Clear();
            }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
    }

    public async ValueTask DisposeAsync()
    {
        channel.Writer.TryComplete();
        await writer.WaitAsync(TimeSpan.FromSeconds(10));
        FlushCounters();
        stop.Dispose();
    }

    private void FlushCounters()
    {
        FlushCounter("queue-full", ref queueFullDrops, ref flushedQueueFullDrops);
        FlushCounter("persistence-failure", ref persistenceFailures, ref flushedPersistenceFailures);
    }

    private void FlushCounter(string name, ref long current, ref long flushed)
    {
        var total = Interlocked.Read(ref current);
        var previous = Interlocked.Read(ref flushed);
        var delta = total - previous;
        if (delta <= 0) return;
        store.AddCounter(name, delta);
        Interlocked.Exchange(ref flushed, total);
    }

    private static DateTimeOffset? FromTicks(long ticks) => ticks == 0 ? null : new DateTimeOffset(ticks, TimeSpan.Zero);
}
