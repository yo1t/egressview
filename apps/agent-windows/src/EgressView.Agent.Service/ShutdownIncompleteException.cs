namespace EgressView.Agent.Service;

/// The service did its work and then failed to put itself away tidily.
///
/// Worth telling apart from a failure to run. Windows records a service that
/// exits with a failure as having terminated unexpectedly, and that entry
/// stays in the event log; writing one for a shutdown that merely took too
/// long to drain says a crash happened when none did. What did not get
/// finished is still worth recording -- the false alarm is not.
internal sealed class ShutdownIncompleteException(Exception inner)
    : Exception("The agent stopped, but could not finish shutting down.", inner);
