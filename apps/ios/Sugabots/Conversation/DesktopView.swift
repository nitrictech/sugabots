import SwiftUI
import WebKit

/// A bot's desktop over the whole screen: the web app's own phone desktop
/// (noVNC over the API's WebSocket, with Close and Take over) in a web view
/// signed in with the person's session, which closes when the page does.
@MainActor
struct DesktopView: View {
	let pod: Pod
	let conversationId: String
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		DesktopWebView(url: store.webURL("pods/\(pod.slug)/threads/\(conversationId)").appending(queryItems: [URLQueryItem(name: "desktop", value: "true")]), cookieDomain: store.client.baseURL.host()) {
			dismiss()
		}
		.ignoresSafeArea()
		.background(Color.black.ignoresSafeArea())
	}
}

private struct DesktopWebView: UIViewRepresentable {
	let url: URL
	let cookieDomain: String?
	let closed: () -> Void

	/// Reports when the page no longer shows the desktop, as its Close leaves it.
	private static let watchClose = """
	(() => {
		const report = () => {
			if (!new URLSearchParams(location.search).has("desktop")) window.webkit.messageHandlers.desktop.postMessage("closed");
		};
		for (const name of ["pushState", "replaceState"]) {
			const original = history[name];
			history[name] = function (...args) { const result = original.apply(this, args); report(); return result; };
		}
		addEventListener("popstate", report);
	})();
	"""

	func makeCoordinator() -> Coordinator { Coordinator(closed: closed) }

	func makeUIView(context: Context) -> WKWebView {
		let configuration = WKWebViewConfiguration()
		configuration.userContentController.add(context.coordinator, name: "desktop")
		configuration.userContentController.addUserScript(WKUserScript(source: Self.watchClose, injectionTime: .atDocumentStart, forMainFrameOnly: true))
		let view = WKWebView(frame: .zero, configuration: configuration)
		view.isOpaque = false
		view.backgroundColor = .black
		view.scrollView.contentInsetAdjustmentBehavior = .never
		// The session the app signed in with, as a cookie, so the page and its desktop socket are the person's.
		let cookies = (HTTPCookieStorage.shared.cookies ?? []).filter { cookie in
			guard let cookieDomain else { return false }
			return cookieDomain.hasSuffix(cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")))
		}
		let store = configuration.websiteDataStore.httpCookieStore
		Task { @MainActor in
			for cookie in cookies { await store.setCookie(cookie) }
			view.load(URLRequest(url: url))
		}
		return view
	}

	func updateUIView(_: WKWebView, context _: Context) {}

	final class Coordinator: NSObject, WKScriptMessageHandler {
		let closed: () -> Void

		init(closed: @escaping () -> Void) {
			self.closed = closed
		}

		func userContentController(_: WKUserContentController, didReceive _: WKScriptMessage) {
			closed()
		}
	}
}
