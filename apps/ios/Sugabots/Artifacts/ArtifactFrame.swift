import SwiftUI
import WebKit

/// How each kind of artifact is named and saved, as the web's `ARTIFACT_KINDS`;
/// a kind this app doesn't know is shown as a document.
extension ArtifactKind {
	var label: String { Self.labels[shownAs.rawValue] ?? "" }

	var icon: Lucide {
		switch self {
		case .html: .panelsTopLeft
		case .document, .unknown: .fileText
		}
	}

	/// What Download saves it as.
	var fileExtension: String { Self.fileExtensions[shownAs.rawValue] ?? "" }

	private var shownAs: ArtifactKind {
		if case .unknown = self { .document } else { self }
	}
}

/// A bot-made page running in a web view that keeps nothing and reaches
/// nothing, as the web's `HtmlFrame`: from the installation's content origin
/// when it has one, else written in with the page's content policy before
/// anything else. The app's colours reach the page as the web's tokens.
/// With `fitHeight`, it reports how tall the page is.
struct ArtifactFrame: View {
	let html: String
	let title: String
	let podId: String
	let artifactId: String
	let version: Int
	var fitHeight = false
	var onPageHeight: ((CGFloat) -> Void)?
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.colorScheme) private var colorScheme
	@State private var source: PageWebView.Source?
	@State private var failed = false

	var body: some View {
		Group {
			if let source {
				PageWebView(source: source, onPageHeight: fitHeight ? onPageHeight : nil)
			} else if failed {
				VStack(spacing: 12) {
					FormAlert(text: "This page couldn't be loaded.").fixedSize()
					Button("Try again") { Task { await load() } }.buttonStyle(WebButtonStyle(variant: .secondary, size: .small))
				}
				.frame(maxWidth: .infinity, minHeight: ArtifactFrame.fitHeight.min)
			} else {
				Color.clear.frame(minHeight: ArtifactFrame.fitHeight.min)
			}
		}
		.task(id: colorScheme) { await load() }
		.accessibilityLabel(title)
	}

	/// How tall a page in a card may be, as `FIT_HEIGHT_PX`.
	static let fitHeight = (min: CGFloat(120), max: CGFloat(560))

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

	/// As `PAGE_CONTENT_POLICY` in `@sugabots/contracts/artifact-pages`.
	static let contentPolicy = [
		"default-src 'none'",
		"script-src 'unsafe-inline' https://cdn.jsdelivr.net",
		"style-src 'unsafe-inline'",
		"img-src data: blob:",
		"font-src data:",
		"media-src data: blob:",
		"form-action 'none'",
	].joined(separator: "; ")

	/// `FRAME_TOKENS` with the values `app.css` gives each in light and dark.
	private static let tokens: [(name: String, light: String, dark: String)] = [
		("--background", "#ffffff", "#0a0a0a"),
		("--card", "#f7f7f8", "#111113"),
		("--panel", "#ffffff", "#111113"),
		("--chip", "#f1f1f3", "#17171a"),
		("--hover", "#e4e4e7", "#1f1f23"),
		("--foreground", "#111113", "#ededed"),
		("--body-foreground", "#1c1c1f", "#ededed"),
		("--muted-foreground", "#52525b", "#a1a1aa"),
		("--subtle-foreground", "#6b6b73", "#808089"),
		("--border", "#e4e4e7", "#1c1c1f"),
		("--border-strong", "#d4d4d8", "#26262a"),
		("--primary", "#111113", "#ededed"),
		("--primary-foreground", "#ffffff", "#0a0a0a"),
		("--link", "#111113", "#ededed"),
		("--success-text", "#1a7f37", "#4ade80"),
		("--destructive-text", "#c42d45", "#f08a94"),
		("--warning", "#8a5a12", "#e0b67b"),
		("--font-sans", "\"Rubik\", system-ui, sans-serif", "\"Rubik\", system-ui, sans-serif"),
		("--font-mono", "\"JetBrains Mono\", ui-monospace, Menlo, monospace", "\"JetBrains Mono\", ui-monospace, Menlo, monospace"),
	]

	var colorScheme: String { dark ? "dark" : "light" }

	var tokenDeclarations: String {
		Self.tokens.map { "\($0.name): \(dark ? $0.dark : $0.light);" }.joined(separator: " ")
	}

	var css: String {
		":root { color-scheme: \(colorScheme); \(tokenDeclarations) } html, body { background: transparent; } body { margin: 0; color: var(--body-foreground); font-family: var(--font-sans); }"
	}

	/// The theme as the page served from the content origin reads it from its fragment.
	var json: String {
		let object = ["colorScheme": colorScheme, "tokens": tokenDeclarations]
		let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
		return String(decoding: data, as: UTF8.self)
	}

	/// `html` with the content policy and the theme before anything else in it, after any doctype.
	func written(into html: String) -> String {
		let tags = "<meta http-equiv=\"Content-Security-Policy\" content=\"\(Self.contentPolicy)\"><style>\(css)</style>"
		let trimmed = html.drop { $0.isWhitespace }
		guard trimmed.lowercased().hasPrefix("<!doctype"), let end = trimmed.firstIndex(of: ">") else { return tags + html }
		return String(trimmed[...end]) + tags + String(trimmed[trimmed.index(after: end)...])
	}
}

/// A web view that keeps nothing between pages, opens nothing else, and can say how tall its page is.
struct PageWebView: UIViewRepresentable {
	enum Source: Equatable {
		case url(URL)
		case html(String)
	}

	let source: Source
	var onPageHeight: ((CGFloat) -> Void)?

	/// Reports the page's height whenever it changes, as the web's `PAGE_HEIGHT_REPORT` does.
	private static let heightReport = """
	new ResizeObserver(() => window.webkit.messageHandlers.pageHeight.postMessage(document.documentElement.scrollHeight)).observe(document.documentElement);
	"""

	func makeCoordinator() -> Coordinator { Coordinator() }

	func makeUIView(context: Context) -> WKWebView {
		let configuration = WKWebViewConfiguration()
		configuration.websiteDataStore = .nonPersistent()
		if onPageHeight != nil {
			configuration.userContentController.add(context.coordinator, name: "pageHeight")
			configuration.userContentController.addUserScript(
				WKUserScript(source: Self.heightReport, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
			)
		}
		let view = WKWebView(frame: .zero, configuration: configuration)
		view.isOpaque = false
		view.backgroundColor = .clear
		view.scrollView.backgroundColor = .clear
		view.navigationDelegate = context.coordinator
		view.scrollView.isScrollEnabled = onPageHeight == nil
		context.coordinator.onPageHeight = onPageHeight
		load(source, into: view, context: context)
		return view
	}

	func updateUIView(_ view: WKWebView, context: Context) {
		context.coordinator.onPageHeight = onPageHeight
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

		/// Only the page itself loads here; a link it follows opens nothing.
		func webView(_: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
			action.navigationType == .other ? .allow : .cancel
		}
	}
}
