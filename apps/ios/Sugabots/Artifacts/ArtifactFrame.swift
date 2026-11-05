import SwiftUI
import WebKit

extension ArtifactKind {
	/// Its mark, as the web's `ARTIFACT_KINDS` draws it; a kind this app doesn't know is drawn as a document.
	var icon: Lucide {
		switch self {
		case .html: .panelsTopLeft
		case .document, .unknown: .fileText
		}
	}
}

/// A bot-made page in a web view, as the web's `HtmlFrame`: served from the
/// installation's content origin when it has one, else written in with the
/// page's content policy before anything else. The view keeps nothing between
/// pages and loads nothing but the page: what the page fetches is limited by
/// the content policy, and any navigation it starts is cancelled. The app's
/// colours reach the page as the web's tokens. With `onPageHeight`, it reports
/// how tall the page is, and leaves scrolling to whatever holds it.
struct ArtifactFrame: View {
	let html: String
	let title: String
	let podId: String
	let artifactId: String
	let version: Int
	var onPageHeight: ((CGFloat) -> Void)?
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.colorScheme) private var colorScheme
	@State private var source: PageWebView.Source?
	@State private var failed = false

	var body: some View {
		Group {
			if let source {
				PageWebView(source: source, onPageHeight: onPageHeight)
			} else if failed {
				VStack(spacing: 12) {
					FormAlert(text: "This page couldn't be loaded.").fixedSize()
					Button("Try again") { Task { await load() } }.buttonStyle(WebButtonStyle(variant: .secondary, size: .small))
				}
				.frame(maxWidth: .infinity, minHeight: PageFrame.fitHeight.min)
			} else {
				Color.clear.frame(minHeight: PageFrame.fitHeight.min)
			}
		}
		.task(id: colorScheme) { await load() }
		.accessibilityLabel(title)
	}

	private func load() async {
		failed = false
		let theme = PageTheme(dark: colorScheme == .dark)
		do {
			if let url = try await store.pageAddress(artifactId, in: podId, version: version) {
				var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
				components?.fragment = theme.json
				source = components?.url.map(PageWebView.Source.url)
			} else {
				source = .html(theme.written(into: html))
			}
		} catch {
			failed = true
		}
	}
}

/// The app's colour scheme and tokens, as the web hands them to a page (`pageThemeCss`).
struct PageTheme {
	let dark: Bool

	var colorScheme: String { dark ? "dark" : "light" }

	var tokenDeclarations: String {
		PageFrame.tokens.map { "\($0.name): \(dark ? $0.dark : $0.light);" }.joined(separator: " ")
	}

	var css: String { PageFrame.themeCss(colorScheme: colorScheme, tokens: tokenDeclarations) }

	/// The theme as the page served from the content origin reads it from its fragment.
	var json: String {
		let object = ["colorScheme": colorScheme, "tokens": tokenDeclarations]
		let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
		return String(decoding: data, as: UTF8.self)
	}

	/// `html` with the content policy and the theme before anything else in it, after any doctype.
	func written(into html: String) -> String {
		let tags = "<meta http-equiv=\"Content-Security-Policy\" content=\"\(PageFrame.contentPolicy)\"><style>\(css)</style>"
		let trimmed = html.drop { $0.isWhitespace }
		guard trimmed.lowercased().hasPrefix("<!doctype"), let end = trimmed.firstIndex(of: ">") else { return tags + html }
		return String(trimmed[...end]) + tags + String(trimmed[trimmed.index(after: end)...])
	}
}

/// A web view that keeps nothing between pages, loads nothing but `source`,
/// and, with `onPageHeight`, says how tall its page is instead of scrolling it.
struct PageWebView: UIViewRepresentable {
	enum Source: Equatable {
		case url(URL)
		case html(String)

		/// The address the web view's main frame loads it at: its own, or a blank page's for written-in HTML.
		var address: URL {
			switch self {
			case let .url(url): url
			case .html: Self.blankPage
			}
		}

		private static let blankPage = URL(string: "about:blank")!
	}

	let source: Source
	var onPageHeight: ((CGFloat) -> Void)?

	func makeCoordinator() -> Coordinator { Coordinator() }

	func makeUIView(context: Context) -> WKWebView {
		let configuration = WKWebViewConfiguration()
		configuration.websiteDataStore = .nonPersistent()
		configuration.userContentController.add(context.coordinator, name: PageFrame.heightMessageHandler)
		configuration.userContentController.addUserScript(
			WKUserScript(source: PageFrame.heightReport, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
		)
		let view = WKWebView(frame: .zero, configuration: configuration)
		view.isOpaque = false
		view.backgroundColor = .clear
		view.scrollView.backgroundColor = .clear
		view.navigationDelegate = context.coordinator
		return view
	}

	func updateUIView(_ view: WKWebView, context: Context) {
		context.coordinator.onPageHeight = onPageHeight
		view.scrollView.isScrollEnabled = onPageHeight == nil
		if context.coordinator.loaded != source { load(source, into: view, context: context) }
	}

	private func load(_ source: Source, into view: WKWebView, context: Context) {
		context.coordinator.loaded = source
		switch source {
		case let .url(url): view.load(URLRequest(url: url))
		case let .html(html): view.loadHTMLString(html, baseURL: nil)
		}
	}

	final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
		var onPageHeight: ((CGFloat) -> Void)?
		var loaded: Source?

		func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
			guard let height = message.body as? Double else { return }
			onPageHeight?(CGFloat(height))
		}

		/// Only `loaded` loads, in the main frame, at its own address; a jump to
		/// a fragment of it stays in the page. A link the page follows, a script
		/// or `<meta http-equiv="refresh">` sending it elsewhere, or a frame in it
		/// opens nothing, so the page can't carry what it holds away in an address.
		func webView(_: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
			guard let loaded, action.targetFrame?.isMainFrame == true, let requested = action.request.url,
				Self.withoutFragment(requested) == Self.withoutFragment(loaded.address)
			else { return .cancel }
			return .allow
		}

		/// `url` without its fragment, which carries the page's theme and never leaves the web view.
		private static func withoutFragment(_ url: URL) -> URL? {
			var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
			components?.fragment = nil
			return components?.url
		}
	}
}
