import AppKit
import EgressViewAgentCore
import SwiftUI

// Where the traffic went, drawn on a turning globe.
//
// The drawing is an NSView rather than a SwiftUI Canvas: a Canvas produces
// nothing for VoiceOver to land on, and the rotation cannot live in @State
// because SwiftUI may discard a state change made during rendering -- and did.

struct AgentGlobeChart: View {
    let model: GlobeModel
    let atlas: WorldAtlas?

    private enum CountryView: String, CaseIterable, Identifiable {
        case globe
        case destinations

        var id: String { rawValue }

        var title: String {
            switch self {
            case .globe: return L("Globe")
            case .destinations: return L("Destination countries")
            }
        }
    }

    /// How fast the globe turns, if it turns at all.
    ///
    /// A still globe hides half the destinations behind it with no sign that
    /// they are there, so it turns by default. But rotation also makes a place
    /// hard to read while it moves, so it can be stopped and slowed.
    enum SpinSpeed: String, CaseIterable, Identifiable {
        case slow, normal, fast
        var id: String { rawValue }

        /// Degrees of longitude per second.
        var degreesPerSecond: Double {
            switch self {
            case .slow: return 2
            case .normal: return 6
            case .fast: return 16
            }
        }

        var title: String {
            switch self {
            case .slow: return L("Slow")
            case .normal: return L("Normal")
            case .fast: return L("Fast")
            }
        }
    }

    @State private var speed: SpinSpeed = .normal
    @State private var isRunning = true
    @State private var countryView: CountryView = .globe
    @AppStorage(AgentGlobeFrameRate.defaultsKey)
    private var frameRateRaw = AgentGlobeFrameRate.defaultValue.rawValue

    /// Whether the globe should be turning at all.
    ///
    /// A globe nobody can see does not need to turn. Spinning behind another
    /// window or in a hidden tab cost the same CPU as spinning in front of the
    /// user, which is a bad trade at any frame rate.
    ///
    /// `controlActiveState` alone did not carry that intent. It reports whether
    /// the **application** is active, not whether this window is on screen, so
    /// closing the window left the globe turning at fifteen frames a second
    /// behind nothing at all. The view is never torn down -- the hosting
    /// controller is held for the life of the app -- so nothing else stopped
    /// it either, and each frame re-lays out this whole subtree.
    @Environment(\.controlActiveState) private var controlActiveState

    /// Whether the window is on screen and this globe's tab is the one showing.
    let isOnScreen: Bool

    private var isAnimating: Bool {
        isOnScreen && isRunning && controlActiveState != .inactive
    }

    private var frameRate: AgentGlobeFrameRate {
        AgentGlobeFrameRate(rawValue: frameRateRaw) ?? .defaultValue
    }

    private var spinControls: some View {
        HStack(spacing: 10) {
            Button {
                isRunning.toggle()
            } label: {
                Label(
                    isRunning ? L("Stop") : L("Rotate"),
                    systemImage: isRunning ? "pause.fill" : "play.fill"
                )
            }
            .help(isRunning
                  ? L("Stop the globe where it is")
                  : L("Turn the globe so the far side comes round"))

            Picker(L("Speed"), selection: Binding(
                get: { speed },
                set: { speed = $0 }
            )) {
                ForEach(SpinSpeed.allCases) { value in
                    Text(value.title).tag(value)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 170)
            .disabled(!isRunning)
        }
        .font(.caption)
        .controlSize(.small)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .center, spacing: 12) {
                    Text(L("Where the traffic went"))
                        .font(.title3.weight(.semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                        .allowsTightening(true)
                        .layoutPriority(1)
                    Spacer(minLength: 8)
                    Picker(L("Country view"), selection: $countryView) {
                        ForEach(CountryView.allCases) { view in
                            Text(view.title).tag(view)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .frame(width: 165)
                }
                Text(model.metric == .bytes
                     ? L("Mark size is data volume")
                     : L("Mark size is the number of connections"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.90)
                    .allowsTightening(true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if countryView == .globe {
                if let unavailable = model.unavailable {
                    AgentEmptyChartNote(text: message(for: unavailable))
                } else {
                    AgentGlobeNativeView(
                        model: model,
                        atlas: atlas,
                        degreesPerSecond: speed.degreesPerSecond,
                        framesPerSecond: frameRate.rawValue,
                        isRotating: isRunning,
                        isAnimating: isAnimating
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .overlay(alignment: .bottomTrailing) {
                        // Overlaid rather than stacked below: the globe is drawn
                        // from the smaller side of its box, so every point of
                        // height the controls took came straight off the sphere.
                        //
                        // The native view redraws independently, but fixed sizing
                        // also keeps these controls stable while the card resizes.
                        spinControls
                            .fixedSize()
                            .padding(8)
                            .background(
                                RoundedRectangle(cornerRadius: 9, style: .continuous)
                                    .fill(Color(nsColor: .controlBackgroundColor).opacity(0.45))
                            )
                            .overlay {
                                RoundedRectangle(cornerRadius: 9, style: .continuous)
                                    .strokeBorder(Color.primary.opacity(0.10), lineWidth: 1)
                            }
                            .padding(6)
                    }
                    .accessibilityElement()
                    // Measured 2026-09-03: without this the globe is AXUnknown,
                    // while the sankey and the timeline are AXImage. The three
                    // are the same kind of thing and were read as two.
                    .accessibilityAddTraits(.isImage)
                    .accessibilityLabel(summary)
                }
                if !model.visitedCountryCodes.isEmpty {
                    Button {
                        countryView = .destinations
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "paintbrush.pointed")
                            Text(L("%lld countries are shaded from all-time local history.",
                                   model.visitedCountryCodes.count))
                            Image(systemName: "chevron.right")
                                .font(.caption2.weight(.semibold))
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .font(.caption)
                    .foregroundStyle(.teal)
                    .help(L("Show destination countries"))
                }
            } else {
                AgentCountryHistoryList(rows: model.countryHistory)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .agentSection()
    }

    private func message(for reason: GlobeUnavailableReason) -> String {
        switch reason {
        case .noLocationData:
            return L("No location data yet. Connect to a Hub, or enable direct lookups in settings.")
        case .noTrafficInPeriod:
            return L("No connections in this period.")
        }
    }

    private var summary: String {
        guard let busiest = model.points.last else {
            return L("No connections in this period. %lld countries are retained in local history.",
                     model.visitedCountryCodes.count)
        }
        let place = busiest.city ?? busiest.countryCode ?? L("an unnamed place")
        return L("%1$lld places, %2$lld%% of traffic placed. The busiest is %3$@. %4$lld countries are retained in local history.",
                 model.points.count, Int((model.placedShare * 100).rounded()), place,
                 model.visitedCountryCodes.count)
    }

}

private struct AgentCountryHistoryList: View {
    let rows: [CountryVisitSummary]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(L("Destination countries"))
                    .font(.title3.bold())
                Text(L("This list is local and independent of the selected period."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if rows.isEmpty {
                AgentEmptyChartNote(text: L("No destination countries have been recorded yet."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(rows) { row in
                            HStack(alignment: .top, spacing: 10) {
                                Text(Self.flag(for: row.countryCode))
                                    .font(.title2)
                                    .accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: 5) {
                                    HStack(alignment: .firstTextBaseline) {
                                        Text(Self.countryName(for: row.countryCode))
                                            .font(.headline)
                                        Spacer(minLength: 8)
                                        Text(L("%lld times", row.connectionCount))
                                            .font(.caption.weight(.semibold))
                                            .monospacedDigit()
                                            .foregroundStyle(.teal)
                                    }
                                    countryHistoryField(
                                        L("First accessed"),
                                        date: row.firstObservedAt
                                    )
                                    countryHistoryField(
                                        L("Last accessed"),
                                        date: row.lastObservedAt
                                    )
                                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                                        Text(L("Latest application"))
                                            .foregroundStyle(.secondary)
                                        Text(row.lastProcessName.isEmpty
                                             ? L("Unknown") : row.lastProcessName)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                    }
                                    .font(.caption)
                                }
                            }
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(
                                RoundedRectangle(cornerRadius: 9, style: .continuous)
                                    .fill(Color.teal.opacity(0.07))
                            )
                        }
                    }
                    .padding(.trailing, 4)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private static func countryName(for code: String) -> String {
        Locale.current.localizedString(forRegionCode: code) ?? code
    }

    private func countryHistoryField(_ label: String, date: Date) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(label)
                .foregroundStyle(.secondary)
            Text(date, format: .dateTime.year().month().day().hour().minute())
                .monospacedDigit()
        }
        .font(.caption)
    }

    private static func flag(for code: String) -> String {
        let scalars = code.uppercased().unicodeScalars.compactMap { scalar -> UnicodeScalar? in
            guard scalar.value >= 65, scalar.value <= 90 else { return nil }
            return UnicodeScalar(127_397 + scalar.value)
        }
        return scalars.count == 2 ? String(String.UnicodeScalarView(scalars)) : ""
    }
}

/// Runs the globe clock and renderer outside SwiftUI. A frame invalidates only
/// this native view instead of re-evaluating the chart card and its controls.
private struct AgentGlobeNativeView: NSViewRepresentable {
    let model: GlobeModel
    let atlas: WorldAtlas?
    let degreesPerSecond: Double
    let framesPerSecond: Int
    let isRotating: Bool
    let isAnimating: Bool

    func makeNSView(context: Context) -> AgentGlobeDrawingView {
        AgentGlobeDrawingView()
    }

    func updateNSView(_ view: AgentGlobeDrawingView, context: Context) {
        view.configure(
            model: model,
            atlas: atlas,
            degreesPerSecond: degreesPerSecond,
            framesPerSecond: framesPerSecond,
            isRotating: isRotating,
            isAnimating: isAnimating
        )
    }
}

private final class AgentGlobeDrawingView: NSView {
    private var model: GlobeModel?
    private var atlas: WorldAtlas?
    private var home = HomeLocation.current()
    private var tilt = HomeLocation.preferredTilt(latitude: HomeLocation.current().latitude)
    private var baseSpin = 0.0
    private var anchor = Date()
    private var resumeAt = Date.distantPast
    private var degreesPerSecond = 6.0
    private var framesPerSecond = AgentGlobeFrameRate.defaultValue.rawValue
    private var isRotating = true
    private var isAnimating = false
    private var isDragging = false
    private var timer: Timer?

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
        // Core Animation may prepare this layer away from the main display
        // pass. The animation clock still runs on the main run loop.
        layer?.drawsAsynchronously = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        timer?.invalidate()
    }

    func configure(
        model: GlobeModel,
        atlas: WorldAtlas?,
        degreesPerSecond: Double,
        framesPerSecond: Int,
        isRotating: Bool,
        isAnimating: Bool
    ) {
        let contentChanged = self.model != model
        let speedChanged = self.degreesPerSecond != degreesPerSecond
        let rotationChanged = self.isRotating != isRotating
        if speedChanged || rotationChanged { freeze() }
        self.model = model
        self.atlas = atlas
        self.degreesPerSecond = degreesPerSecond
        self.framesPerSecond = framesPerSecond
        self.isRotating = isRotating
        self.isAnimating = isAnimating
        if rotationChanged { anchor = Date() }
        reconcileTimer()
        if contentChanged || speedChanged || rotationChanged || !isAnimating {
            needsDisplay = true
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        reconcileTimer()
    }

    private func reconcileTimer() {
        let shouldRun = isAnimating && window != nil
        if !shouldRun {
            timer?.invalidate()
            timer = nil
            return
        }
        let interval = 1.0 / Double(max(1, framesPerSecond))
        if let timer, abs(timer.timeInterval - interval) < 0.0001 { return }
        timer?.invalidate()
        let next = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            self?.needsDisplay = true
        }
        timer = next
        RunLoop.main.add(next, forMode: .common)
    }

    private func spin(at date: Date = Date()) -> Double {
        guard isRotating, !isDragging else { return baseSpin }
        let elapsed = date.timeIntervalSince(max(anchor, resumeAt))
        return baseSpin + max(0, elapsed) * degreesPerSecond
    }

    private func freeze(at date: Date = Date()) {
        baseSpin = spin(at: date)
        anchor = date
    }

    override func mouseDown(with event: NSEvent) {
        freeze()
        isDragging = true
    }

    override func mouseDragged(with event: NSEvent) {
        baseSpin += event.deltaX * 0.4
        tilt = max(-80, min(80, tilt + event.deltaY * 0.4))
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        isDragging = false
        anchor = Date()
        // Let the user inspect the place they turned to before rotation resumes.
        resumeAt = anchor.addingTimeInterval(2.5)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let model, let context = NSGraphicsContext.current?.cgContext else { return }
        draw(model: model, atlas: atlas, in: context, size: bounds.size, spin: spin())
    }

    private func draw(
        model: GlobeModel,
        atlas: WorldAtlas?,
        in context: CGContext,
        size: CGSize,
        spin: Double
    ) {
        let side = min(size.width, size.height)
        let rect = CGRect(
            x: (size.width - side) / 2,
            y: (size.height - side) / 2,
            width: side,
            height: side
        )
        let projection = OrthographicProjection(
            centerLatitude: tilt,
            centerLongitude: home.longitude - spin
        )

        context.setFillColor(NSColor.systemBlue.withAlphaComponent(0.10).cgColor)
        context.fillEllipse(in: rect)
        context.setStrokeColor(NSColor.cyan.withAlphaComponent(0.35).cgColor)
        context.setLineWidth(1)
        context.strokeEllipse(in: rect)

        if let atlas {
            let land = CGMutablePath()
            let visitedLand = CGMutablePath()
            for country in atlas.countries {
                let isVisited = country.code.map(model.visitedCountryCodes.contains) ?? false
                for ring in country.rings {
                    var started = false
                    var visitedSegmentOpen = false
                    for point in ring {
                        guard let projected = projection.project(
                            latitude: point.latitude,
                            longitude: point.longitude,
                            in: rect
                        ) else {
                            started = false
                            if visitedSegmentOpen {
                                visitedLand.closeSubpath()
                                visitedSegmentOpen = false
                            }
                            continue
                        }
                        if started {
                            land.addLine(to: projected)
                        } else {
                            land.move(to: projected)
                            started = true
                        }
                        if isVisited {
                            if visitedSegmentOpen {
                                visitedLand.addLine(to: projected)
                            } else {
                                visitedLand.move(to: projected)
                                visitedSegmentOpen = true
                            }
                        }
                    }
                    if visitedSegmentOpen { visitedLand.closeSubpath() }
                }
            }
            context.saveGState()
            context.addEllipse(in: rect)
            context.clip()
            context.addPath(visitedLand)
            context.setFillColor(NSColor.systemTeal.withAlphaComponent(0.26).cgColor)
            context.drawPath(using: .eoFill)
            context.restoreGState()
            context.addPath(land)
            context.setStrokeColor(NSColor.cyan.withAlphaComponent(0.55).cgColor)
            context.setLineWidth(0.6)
            context.strokePath()
        }

        let homePoint = projection.project(
            latitude: home.latitude,
            longitude: home.longitude,
            in: rect
        )

        for point in model.points {
            let arc = GreatCircle.path(
                from: home,
                to: (latitude: point.latitude, longitude: point.longitude)
            )
            let visible = CGMutablePath()
            let hidden = CGMutablePath()
            var visibleStarted = false
            var hiddenStarted = false
            for step in arc {
                if let projected = projection.project(
                    latitude: step.latitude,
                    longitude: step.longitude,
                    in: rect
                ) {
                    hiddenStarted = false
                    if visibleStarted { visible.addLine(to: projected) } else {
                        visible.move(to: projected)
                        visibleStarted = true
                    }
                } else {
                    visibleStarted = false
                    let edge = projection.projectClamped(
                        latitude: step.latitude,
                        longitude: step.longitude,
                        in: rect
                    )
                    if hiddenStarted { hidden.addLine(to: edge) } else {
                        hidden.move(to: edge)
                        hiddenStarted = true
                    }
                }
            }
            context.addPath(hidden)
            context.setStrokeColor(NSColor.systemOrange.withAlphaComponent(0.10).cgColor)
            context.setLineWidth(0.7)
            context.strokePath()
            context.addPath(visible)
            context.setStrokeColor(NSColor.systemOrange.withAlphaComponent(0.55).cgColor)
            context.setLineWidth(0.9)
            context.strokePath()
        }

        for point in model.points {
            let radius = max(2.0, sqrt(point.weight) * side * 0.14)
            let front = projection.project(
                latitude: point.latitude,
                longitude: point.longitude,
                in: rect
            )
            let position = front ?? projection.projectClamped(
                latitude: point.latitude,
                longitude: point.longitude,
                in: rect
            )
            let mark = CGRect(
                x: position.x - radius,
                y: position.y - radius,
                width: radius * 2,
                height: radius * 2
            )
            context.setFillColor(
                NSColor.systemOrange.withAlphaComponent(front == nil ? 0.18 : 0.85).cgColor
            )
            context.fillEllipse(in: mark)
        }

        if let homePoint {
            let marker = CGRect(x: homePoint.x - 4, y: homePoint.y - 4, width: 8, height: 8)
            context.setFillColor(NSColor.systemYellow.cgColor)
            context.fillEllipse(in: marker)
            context.setStrokeColor(NSColor.systemYellow.withAlphaComponent(0.5).cgColor)
            context.setLineWidth(1)
            context.strokeEllipse(in: marker.insetBy(dx: -3, dy: -3))
        }
    }
}
