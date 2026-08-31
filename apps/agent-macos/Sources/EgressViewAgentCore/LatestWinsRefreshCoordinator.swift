public struct LatestWinsRefreshCoordinator {
    public struct Token: Equatable, Sendable {
        fileprivate let requestID: UInt64
        fileprivate let selectionGeneration: UInt64
    }

    public struct Completion: Equatable, Sendable {
        public let shouldApply: Bool
        public let next: Token?
    }

    private var selectionGeneration: UInt64 = 0
    private var nextRequestID: UInt64 = 0
    private var active: Token?
    private var refreshPending = false

    public init() {}

    /// Records a user-visible selection change and requests data for it.
    /// Passing false invalidates an active result without starting work, as
    /// required by tabs whose data is published by another controller.
    public mutating func selectionChanged(shouldRefresh: Bool) -> Token? {
        selectionGeneration &+= 1
        guard shouldRefresh else {
            refreshPending = false
            return nil
        }
        return requestRefresh()
    }

    /// Coalesces timer and manual refreshes without changing the selection
    /// generation. A slow query may still be applied before one follow-up run.
    public mutating func requestRefresh() -> Token? {
        guard active == nil else {
            refreshPending = true
            return nil
        }
        return beginRequest()
    }

    /// Completes the active request. Results for an old selection are never
    /// applied, and all requests received while it ran become one follow-up.
    public mutating func complete(_ token: Token, shouldContinue: Bool) -> Completion {
        precondition(active == token, "Refresh completion did not match the active request")

        let shouldApply = token.selectionGeneration == selectionGeneration
        active = nil

        guard shouldContinue, refreshPending || !shouldApply else {
            refreshPending = false
            return Completion(shouldApply: shouldApply, next: nil)
        }

        refreshPending = false
        return Completion(shouldApply: shouldApply, next: beginRequest())
    }

    private mutating func beginRequest() -> Token {
        nextRequestID &+= 1
        let token = Token(
            requestID: nextRequestID,
            selectionGeneration: selectionGeneration
        )
        active = token
        return token
    }
}
