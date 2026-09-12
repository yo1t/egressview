import Foundation

/// Whether a connection in the log has finished.
///
/// ## What the agent actually knows
///
/// The Network Extension reports a flow **twice**: once when it opens, and
/// once when it closes. Periodic statistics reports in between are discarded
/// on purpose -- whether their counters are cumulative or per-interval is
/// undocumented and unmeasured, and a byte count nobody has verified is worse
/// than none.
///
/// So a row's last-observed time does **not** track a running connection. It
/// is the open time until the flow closes, and the close time afterwards. A
/// connection open for an hour has a last-observed time an hour old, and one
/// that ended a second ago has a very recent one.
///
/// ## The rule that was wrong
///
/// The first version of this marked a row as running when its last-observed
/// time was within a few seconds of the read. On the shipping path that says
/// the opposite of the truth twice over: **a flow that has been open for an
/// hour is not marked, and a flow that ended a second ago is.** It was
/// derived from the two-second sampling interval of `LightweightCollector`,
/// which is disabled in every shipped build.
///
/// ## The rule that holds
///
/// Byte counts arrive with the close report and only then. **A flow with no
/// byte counts has not been reported closed**, which is the same fact the
/// coverage note on the charts already states to the user. That is a property
/// of the record, needs no clock, and cannot be made wrong by how often the
/// window refreshes.
///
/// It is not a claim that the connection is alive this instant. If a close
/// report never arrives -- the extension is replaced, the registry evicts the
/// entry at 10,000 open flows -- the row keeps saying open. What it says
/// precisely is: **the agent has not seen this end.**
public enum ConnectionLogActivity {
    /// Has this flow's end not been recorded?
    ///
    /// Restricted to the Network Extension, which is the collector that
    /// reports closes at all. A row from any other collector gets no claim
    /// made about it rather than a claim that cannot be supported.
    public static func isOpen(_ observation: ConnectionObservation) -> Bool {
        guard observation.collector == .networkExtension else { return false }
        return observation.bytesIn == nil && observation.bytesOut == nil
    }
}
