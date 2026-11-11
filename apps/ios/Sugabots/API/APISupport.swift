import Foundation

// What `API.generated.swift` is written against: how a request is sent and
// how its parts are encoded.

extension APIClient {
	/// How request bodies are written: timestamps as the API writes them.
	static let encoder: JSONEncoder = {
		let encoder = JSONEncoder()
		encoder.dateEncodingStrategy = .custom { date, encoder in
			var container = encoder.singleValueContainer()
			try container.encode(date.iso8601)
		}
		return encoder
	}()

	/// Sends a request and decodes its answer.
	func call<Response: Decodable>(
		_ method: String, _ path: String, query: [URLQueryItem], body: (some Encodable)? = Empty?.none
	) async throws -> Response {
		let data = try await callForData(method, path, query: query, body: body)
		return try Self.decoder.decode(Response.self, from: data)
	}

	/// Sends a request and answers with its body as it came.
	@discardableResult
	func callForData(
		_ method: String, _ path: String, query: [URLQueryItem], body: (some Encodable)? = Empty?.none
	) async throws -> Data {
		var request = request(path, method: method, queryItems: query)
		if let body {
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
			request.httpBody = try Self.encoder.encode(body)
		}
		return try await send(request).0
	}

	/// Sends `data` as the body as it is, as an upload.
	func callForData(_ method: String, _ path: String, query: [URLQueryItem], data: Data) async throws -> Data {
		var request = request(path, method: method, queryItems: query)
		request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
		request.httpBody = data
		return try await send(request).0
	}

	/// Sends `data` as the body as it is, and decodes the answer.
	func call<Response: Decodable>(_ method: String, _ path: String, query: [URLQueryItem], data: Data) async throws -> Response {
		try Self.decoder.decode(Response.self, from: await callForData(method, path, query: query, data: data))
	}

	/// A request with no body.
	struct Empty: Encodable {}
}

/// A value a request can carry in its query string.
protocol QueryValue {
	var queryValue: String { get }
}

extension QueryValue where Self: RawRepresentable, RawValue == String {
	var queryValue: String { rawValue }
}

extension String: QueryValue {
	var queryValue: String { self }
}

extension Int: QueryValue {
	var queryValue: String { String(self) }
}

extension Double: QueryValue {
	var queryValue: String { String(self) }
}

extension Bool: QueryValue {
	var queryValue: String { self ? "true" : "false" }
}

extension Date: QueryValue {
	var queryValue: String { iso8601 }
}

/// A request's query, built a parameter at a time; one left out is not sent.
struct QueryItems {
	private(set) var items: [URLQueryItem] = []

	mutating func add(_ name: String, _ value: (some QueryValue)?) {
		guard let value else { return }
		items.append(URLQueryItem(name: name, value: value.queryValue))
	}

	mutating func add(_ name: String, _ values: [some QueryValue]?) {
		for value in values ?? [] {
			items.append(URLQueryItem(name: name, value: value.queryValue))
		}
	}
}

/// A key named at runtime: the property a union is told apart by.
struct AnyCodingKey: CodingKey {
	let stringValue: String
	var intValue: Int? { nil }

	init(_ stringValue: String) {
		self.stringValue = stringValue
	}

	init?(stringValue: String) {
		self.stringValue = stringValue
	}

	init?(intValue _: Int) {
		nil
	}
}

/// Any JSON value: what a tool call took and returned.
enum JSONValue: Codable, Hashable, Sendable {
	case string(String)
	case number(Double)
	case bool(Bool)
	case null
	case array([JSONValue])
	case object([String: JSONValue])

	init(from decoder: any Decoder) throws {
		let container = try decoder.singleValueContainer()
		if container.decodeNil() {
			self = .null
		} else if let value = try? container.decode(Bool.self) {
			self = .bool(value)
		} else if let value = try? container.decode(Double.self) {
			self = .number(value)
		} else if let value = try? container.decode(String.self) {
			self = .string(value)
		} else if let value = try? container.decode([JSONValue].self) {
			self = .array(value)
		} else {
			self = try .object(container.decode([String: JSONValue].self))
		}
	}

	func encode(to encoder: any Encoder) throws {
		var container = encoder.singleValueContainer()
		switch self {
		case let .string(value): try container.encode(value)
		case let .number(value): try container.encode(value)
		case let .bool(value): try container.encode(value)
		case .null: try container.encodeNil()
		case let .array(values): try container.encode(values)
		case let .object(fields): try container.encode(fields)
		}
	}

	/// Pretty-printed, as a request's fields are shown for approval.
	var prettyPrinted: String {
		switch self {
		case let .string(value): return value
		case let .number(value): return Int(exactly: value).map(String.init) ?? String(value)
		case let .bool(value): return String(value)
		case .null: return "null"
		case .array, .object:
			guard
				let data = try? JSONSerialization.data(withJSONObject: foundationValue, options: [.prettyPrinted, .sortedKeys]),
				let text = String(data: data, encoding: .utf8)
			else { return "" }
			return text
		}
	}

	private var foundationValue: Any {
		switch self {
		case let .string(value): value
		case let .number(value): value
		case let .bool(value): value
		case .null: NSNull()
		case let .array(values): values.map(\.foundationValue)
		case let .object(fields): fields.mapValues(\.foundationValue)
		}
	}
}
