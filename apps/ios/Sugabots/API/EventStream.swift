import Foundation

/// One live update: its `type`, and the whole event as JSON, which decodes as the stream's own union, such as `ThreadUpdateEvent`.
struct StreamEvent {
	let type: String
	let data: Data

	func decode<Payload: Decodable>(_: Payload.Type) -> Payload? {
		try? APIClient.decoder.decode(Payload.self, from: data)
	}
}

/// Live updates from a workspace or a thread, as the SDK's `client.events`
/// reads them: server-sent events, reconnecting with `Last-Event-ID` so the
/// server replays what was missed. A dropped connection is normal — the
/// server hangs up every thirty minutes — so only a refusal ends the stream.
enum EventStream {
	private static let firstRetry: Duration = .milliseconds(500)
	private static let maxRetry: Duration = .seconds(30)

	static func workspace(_ workspaceId: String, client: APIClient) -> AsyncStream<StreamEvent> {
		events(at: "workspaces/\(workspaceId)/events", client: client)
	}

	static func thread(_ threadId: String, client: APIClient) -> AsyncStream<StreamEvent> {
		events(at: "threads/\(threadId)/events", client: client)
	}

	private static func events(at path: String, client: APIClient) -> AsyncStream<StreamEvent> {
		AsyncStream { continuation in
			let task = Task {
				var lastEventId: String?
				var retry = firstRetry
				while !Task.isCancelled {
					do {
						var request = client.request(path)
						request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
						// Longer than the gap between the server's pings.
						request.timeoutInterval = 120
						if let lastEventId {
							request.setValue(lastEventId, forHTTPHeaderField: "Last-Event-ID")
						}
						let (bytes, response) = try await client.session.bytes(for: request)
						let status = (response as? HTTPURLResponse)?.statusCode ?? 0
						if status == 204 || isPermanent(status) { break }
						guard (200..<300).contains(status) else { throw URLError(.badServerResponse) }

						// The server writes `id:` (durable events only), `event:`, then the
						// event as JSON on one `data:` line, and `: ping` comments between.
						var id: String?
						for try await line in bytes.lines {
							retry = firstRetry
							if line.hasPrefix("id:") {
								id = field(line)
							} else if line.hasPrefix("data:") {
								if let event = parse(field(line)) {
									if let id { lastEventId = id }
									continuation.yield(event)
								}
								id = nil
							}
						}
					} catch {
						if Task.isCancelled { break }
					}
					try? await Task.sleep(for: jittered(retry))
					retry = min(retry * 2, maxRetry)
				}
				continuation.finish()
			}
			continuation.onTermination = { _ in task.cancel() }
		}
	}

	private static func field(_ line: String) -> String {
		let value = line.drop { $0 != ":" }.dropFirst()
		return String(value.first == " " ? value.dropFirst() : value)
	}

	private static func parse(_ text: String) -> StreamEvent? {
		struct Envelope: Decodable {
			let type: String
		}
		let data = Data(text.utf8)
		guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data) else { return nil }
		return StreamEvent(type: envelope.type, data: data)
	}

	/// A refusal reconnecting cannot fix. A timeout and a rate limit are waited out.
	private static func isPermanent(_ status: Int) -> Bool {
		(400..<500).contains(status) && status != 408 && status != 429
	}

	/// Spread out, so a restart does not bring every client back at once.
	private static func jittered(_ delay: Duration) -> Duration {
		delay * Double.random(in: 0.5...1)
	}
}
