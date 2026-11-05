import Foundation

// What `API.generated.swift` is written against: how a request is sent and
// how its parts are encoded.

extension APIClient {
	/// How request bodies are written: timestamps as the API writes them, and
	/// numbers JSON can't hold as the strings Effect writes for them.
	static let encoder: JSONEncoder = {
		let encoder = JSONEncoder()
		encoder.dateEncodingStrategy = .custom { date, encoder in
			var container = encoder.singleValueContainer()
			try container.encode(date.iso8601)
		}
		encoder.nonConformingFloatEncodingStrategy = .convertToString(
			positiveInfinity: NonFiniteNumberText.positiveInfinity,
			negativeInfinity: NonFiniteNumberText.negativeInfinity,
			nan: NonFiniteNumberText.nan
		)
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

/// The strings Effect writes for the numbers JSON can't hold.
enum NonFiniteNumberText {
	static let positiveInfinity = "Infinity"
	static let negativeInfinity = "-Infinity"
	static let nan = "NaN"
}

/// A value a request can carry in its path or its query string.
protocol ParameterValue {
	var parameterText: String { get }
}

extension ParameterValue where Self: RawRepresentable, RawValue == String {
	var parameterText: String { rawValue }
}

extension String: ParameterValue {
	var parameterText: String { self }
}

extension Int: ParameterValue {
	var parameterText: String { String(self) }
}

extension Double: ParameterValue {
	var parameterText: String { String(self) }
}

extension Bool: ParameterValue {
	var parameterText: String { self ? "true" : "false" }
}

extension Date: ParameterValue {
	var parameterText: String { iso8601 }
}

/// The characters a path segment keeps as they are: RFC 3986's unreserved ones.
private let unreservedCharacters = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

/// `value` as one segment of a request's path, every other character percent-encoded, so a `/` or `?` in it stays inside the segment.
func pathSegment(_ value: some ParameterValue) -> String {
	value.parameterText.addingPercentEncoding(withAllowedCharacters: unreservedCharacters) ?? value.parameterText
}

/// A request's query, built a parameter at a time; one left out is not sent.
struct QueryItems {
	private(set) var items: [URLQueryItem] = []

	mutating func add(_ name: String, _ value: (some ParameterValue)?) {
		guard let value else { return }
		items.append(URLQueryItem(name: name, value: value.parameterText))
	}

	mutating func add(_ name: String, _ values: [some ParameterValue]?) {
		for value in values ?? [] {
			items.append(URLQueryItem(name: name, value: value.parameterText))
		}
	}
}

/// A field a request may leave out, to keep what the server has, or send, even
/// as nil, to change it: `.omitted`, or `.present(nil)` to clear it.
///
/// A struct's synthesized `Codable` writes and reads an `Omittable` field
/// through the `KeyedEncodingContainer` and `KeyedDecodingContainer` methods
/// below, which leave an omitted field out, and read a missing one as omitted.
enum Omittable<Wrapped: Codable & Hashable & Sendable>: Codable, Hashable, Sendable {
	case omitted
	case present(Wrapped?)

	/// The value given, or nil when the field is omitted or cleared.
	var presentValue: Wrapped? {
		if case let .present(value) = self { return value }
		return nil
	}

	init(from decoder: any Decoder) throws {
		let container = try decoder.singleValueContainer()
		self = .present(container.decodeNil() ? nil : try container.decode(Wrapped.self))
	}

	func encode(to encoder: any Encoder) throws {
		var container = encoder.singleValueContainer()
		switch self {
		case .omitted, .present(nil): try container.encodeNil()
		case let .present(value?): try container.encode(value)
		}
	}
}

extension KeyedEncodingContainer {
	mutating func encode<Wrapped>(_ value: Omittable<Wrapped>, forKey key: Key) throws {
		switch value {
		case .omitted: return
		case .present(nil): try encodeNil(forKey: key)
		case let .present(wrapped?): try encode(wrapped, forKey: key)
		}
	}
}

extension KeyedDecodingContainer {
	func decode<Wrapped>(_: Omittable<Wrapped>.Type, forKey key: Key) throws -> Omittable<Wrapped> {
		guard contains(key) else { return .omitted }
		return .present(try decodeIfPresent(Wrapped.self, forKey: key))
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
		// A string is tried before a number: `APIClient.decoder` reads the strings
		// `Infinity`, `-Infinity` and `NaN` as numbers, which here are strings.
		if container.decodeNil() {
			self = .null
		} else if let value = try? container.decode(Bool.self) {
			self = .bool(value)
		} else if let value = try? container.decode(String.self) {
			self = .string(value)
		} else if let value = try? container.decode(Double.self) {
			self = .number(value)
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
		case let .number(value): return value.rounded() == value ? String(Int(value)) : String(value)
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
