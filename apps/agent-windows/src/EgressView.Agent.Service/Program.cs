using EgressView.Agent.Core;

var dataPath = args.Length > 0 ? args[0] : Path.Combine(AppContext.BaseDirectory, "egressview-agent.db");
using var store = new ObservationStore(dataPath);
await using var pipeline = new ObservationPipeline(store);

Console.WriteLine("EgressView Agent for Windows persistence service is ready.");
Console.WriteLine(DiagnosticsReport.Create(pipeline.Snapshot(), store, "0.1.0-dev"));
