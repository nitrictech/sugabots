import Foundation

/// A refusal or failure the API answered with, in its own words.
struct APIFailure: LocalizedError {
	let status: Int
	let message: String
	/// better-auth's reason for refusing, such as `EMAIL_NOT_VERIFIED`.
	var code: String?

	var errorDescription: String? { message }
	var isUnauthorized: Bool { status == 401 }
	/// The account exists but its address hasn't been proven, so signing in waits on the emailed link.
	var isEmailUnverified: Bool { code == "EMAIL_NOT_VERIFIED" }
}

/// The server at the address given answered, but not as a Sugabots server
/// does: it issued no token for a sign-in that succeeded.
struct NotASugabotsServer: LocalizedError {
	var errorDescription: String? { "The server did not issue a token. Is this a Sugabots server?" }
}

/// The API, over HTTP with a bearer token, as `packages/sdk` reaches it in
/// `bearer` mode. `baseURL` carries the API's mount path: `https://sugabots.example.com/api`.
struct APIClient {
	let baseURL: URL
	let tokens: TokenStore
	var session: URLSession = .shared

	/// The web app's address, which the API is mounted under: `https://sugabots.example.com/`.
	var webRoot: URL { baseURL.deletingLastPathComponent() }

	/// How answers are read: timestamps as the API writes them, and the strings
	/// Effect writes for numbers JSON can't hold as those numbers.
	static let decoder: JSONDecoder = {
		let decoder = JSONDecoder()
		decoder.nonConformingFloatDecodingStrategy = .convertFromString(
			positiveInfinity: NonFiniteNumberText.positiveInfinity,
			negativeInfinity: NonFiniteNumberText.negativeInfinity,
			nan: NonFiniteNumberText.nan
		)
		decoder.dateDecodingStrategy = .custom { decoder in
			let text = try decoder.singleValueContainer().decode(String.self)
			guard let date = Date(iso8601: text) else {
				throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not an ISO 8601 timestamp: \(text)"))
			}
			return date
		}
		return decoder
	}()

	// MARK: The account, through better-auth

	/// Signs in with better-auth's email route, and keeps the bearer token it issues.
	func signIn(email: String, password: String) async throws {
		var request = request("auth/sign-in/email", method: "POST", body: ["email": email, "password": password])
		// better-auth refuses a sign-in without an Origin it trusts. The app is
		// not a web page, so it gives the API's own, as the SDK does outside a browser.
		request.setValue(origin, forHTTPHeaderField: "Origin")
		let (_, response) = try await send(request)
		guard let token = response.value(forHTTPHeaderField: "set-auth-token") else { throw NotASugabotsServer() }
		try tokens.store(token)
	}

	/// Makes an account with better-auth's email route. Answers whether it signed
	/// in: an installation that requires a proven address issues no token until
	/// the emailed link is opened.
	func signUp(name: String, email: String, password: String) async throws -> Bool {
		var request = request("auth/sign-up/email", method: "POST", body: ["name": name, "email": email, "password": password])
		request.setValue(origin, forHTTPHeaderField: "Origin")
		let (_, response) = try await send(request)
		guard let token = response.value(forHTTPHeaderField: "set-auth-token") else { return false }
		try tokens.store(token)
		return true
	}

	/// Emails a reset link to `email` if it has an account, opening `redirectTo` on the web.
	func requestPasswordReset(email: String, redirectTo: String) async throws {
		var request = request("auth/request-password-reset", method: "POST", body: ["email": email, "redirectTo": redirectTo])
		request.setValue(origin, forHTTPHeaderField: "Origin")
		_ = try await send(request)
	}

	/// Renames the signed-in person.
	func updateName(_ name: String) async throws {
		var request = request("auth/update-user", method: "POST", body: ["name": name])
		request.setValue(origin, forHTTPHeaderField: "Origin")
		_ = try await send(request)
	}

	func signOut() async {
		var request = request("auth/sign-out", method: "POST", body: [:])
		request.setValue(origin, forHTTPHeaderField: "Origin")
		_ = try? await send(request)
		tokens.clear()
	}

	// MARK: Requests

	// The API's routes are requested through `API.generated.swift`, which is
	// generated from the API's definition. What's here is for what that can't
	// describe: better-auth's routes and the event streams.

	/// A request with the bearer token, for an event stream or another caller
	/// that reads the body itself. `path` is relative to `baseURL`, and already
	/// percent-encoded, as `pathSegment` encodes each of its parameters.
	func request(_ path: String, method: String = "GET", queryItems: [URLQueryItem] = [], body: [String: Any]? = nil) -> URLRequest {
		var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
		let basePath = components.percentEncodedPath.hasSuffix("/") ? components.percentEncodedPath : components.percentEncodedPath + "/"
		components.percentEncodedPath = basePath + path
		if !queryItems.isEmpty {
			components.percentEncodedQueryItems = queryItems.map(Self.encodingPlus)
		}
		var request = URLRequest(url: components.url!)
		request.httpMethod = method
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		if let token = tokens.token {
			request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
		}
		if let body {
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
			request.httpBody = try? JSONSerialization.data(withJSONObject: body)
		}
		return request
	}

	/// Characters a query name or value may hold unencoded. `URLComponents`
	/// leaves `+` as it is, but the server reads a query as a form, where `+`
	/// is a space, so `image/svg+xml` would arrive as `image/svg xml`.
	private static let queryAllowed = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "+&=#"))

	private static func encodingPlus(_ item: URLQueryItem) -> URLQueryItem {
		URLQueryItem(
			name: item.name.addingPercentEncoding(withAllowedCharacters: queryAllowed) ?? item.name,
			value: item.value?.addingPercentEncoding(withAllowedCharacters: queryAllowed)
		)
	}

	private var origin: String {
		var components = URLComponents()
		components.scheme = baseURL.scheme
		components.host = baseURL.host()
		components.port = baseURL.port
		return components.string ?? ""
	}

	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		let (data, response) = try await session.data(for: request)
		guard let http = response as? HTTPURLResponse else {
			throw APIFailure(status: 0, message: "The server sent something other than HTTP.")
		}
		guard (200..<300).contains(http.statusCode) else {
			throw Self.failure(from: data, status: http.statusCode)
		}
		return (data, http)
	}

	/// The API answers failures as `{ "_tag": "NotFound", "message": "…" }`, and better-auth as `{ "message": "…" }`.
	static func failure(from data: Data, status: Int) -> APIFailure {
		struct Body: Decodable {
			let message: String?
			/// better-auth's reason, such as `EMAIL_NOT_VERIFIED`.
			let code: String?
		}
		let body = try? JSONDecoder().decode(Body.self, from: data)
		return APIFailure(
			status: status,
			message: body?.message ?? HTTPURLResponse.localizedString(forStatusCode: status).capitalized,
			code: body?.code
		)
	}
}

extension Date {
	private static let withFraction: ISO8601DateFormatter = {
		let formatter = ISO8601DateFormatter()
		formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		return formatter
	}()

	private static let withoutFraction = ISO8601DateFormatter()

	/// As the API writes a timestamp: `2026-10-30T09:00:00.000Z`.
	var iso8601: String { Self.withFraction.string(from: self) }

	init?(iso8601 text: String) {
		guard let date = Self.withFraction.date(from: text) ?? Self.withoutFraction.date(from: text) else { return nil }
		self = date
	}
}
