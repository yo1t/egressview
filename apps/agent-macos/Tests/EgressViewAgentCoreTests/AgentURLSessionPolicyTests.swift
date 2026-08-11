import Foundation
import XCTest
@testable import EgressViewAgentCore

final class AgentURLSessionPolicyTests: XCTestCase {
    func testRedirectsAreNeverFollowedToAnotherDestination() throws {
        let delegate = AgentNoRedirectDelegate()
        let originalURL = try XCTUnwrap(URL(string: "https://hub.example/api/agent/ingest"))
        let redirectedURL = try XCTUnwrap(URL(string: "https://unexpected.example/collect"))
        let task = URLSession.shared.dataTask(with: originalURL)
        let response = try XCTUnwrap(HTTPURLResponse(
            url: originalURL,
            statusCode: 307,
            httpVersion: nil,
            headerFields: ["Location": redirectedURL.absoluteString]
        ))
        let completion = expectation(description: "redirect decision")

        delegate.urlSession(
            URLSession.shared,
            task: task,
            willPerformHTTPRedirection: response,
            newRequest: URLRequest(url: redirectedURL)
        ) { request in
            XCTAssertNil(request)
            completion.fulfill()
        }

        wait(for: [completion], timeout: 1)
    }
}
