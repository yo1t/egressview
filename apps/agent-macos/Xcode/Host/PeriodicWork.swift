import Foundation

/// Runs something on a schedule, in an app that macOS would rather leave alone.
///
/// `Timer.scheduledTimer` is the obvious way to do this and it does not work
/// here. This agent lives as a background accessory with no windows, which is
/// precisely what App Nap throttles, and its run-loop timers stop firing.
///
/// Measured on 2026-08-19: over 200 seconds, a 60-second run-loop timer fired
/// **zero** times while a dispatch source scheduled beside it fired all nine
/// times it should have. The consequence was not theoretical -- the check that
/// notices a stopped agent had been running once per launch and never again,
/// in every build that has ever shipped.
///
/// The source is scheduled on a **background** queue and hops to the main queue
/// to do the work. Scheduling it on `.main` directly is not enough and was
/// measured not to be: a napped app's main queue is serviced by the same
/// stalled run loop, and a main-queue source fired zero times in 200 seconds
/// exactly as the `Timer` had. Only the background queue kept running.
///
/// The app also asks macOS not to nap it (`AgentAppDelegate`), which is the
/// other half of the same fix. Both are kept: the assertion states the intent,
/// the queue makes the schedule hold even if the assertion is ever dropped.
final class PeriodicWork {
    private static let queue = DispatchQueue(
        label: "com.egressview.agent.periodic", qos: .utility
    )

    private var source: DispatchSourceTimer?

    /// Starts the schedule. Calling it again replaces the previous one.
    ///
    /// `runNow` performs the work immediately as well; the first scheduled run
    /// still happens one interval later.
    func start(
        every interval: TimeInterval, runNow: Bool = false, _ work: @escaping () -> Void
    ) {
        stop()
        if runNow { work() }
        let timer = DispatchSource.makeTimerSource(queue: Self.queue)
        timer.schedule(deadline: .now() + interval, repeating: interval)
        timer.setEventHandler { DispatchQueue.main.async(execute: work) }
        timer.resume()
        source = timer
    }

    func stop() {
        source?.cancel()
        source = nil
    }

    deinit { source?.cancel() }
}
