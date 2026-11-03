import SwiftUI

/// Signing in or making an account, as the web's `Login`: the welcome first,
/// then the email form, with Forgot password and Create an account under it.
/// The app also needs the server, which the web doesn't: it is named quietly
/// at the foot, where it can be changed.
@MainActor
struct SignInScreen: View {
	private enum Page {
		case welcome
		case form
		case forgotPassword
		/// The address of an account that exists but hasn't been proven.
		case unverified(String)
	}

	@Environment(Session.self) private var session
	@State private var page = Page.welcome
	@State private var isNew = false
	@State private var server = ""
	@State private var choosingServer = false

	var body: some View {
		Group {
			switch page {
			case .welcome:
				Welcome { page = .form }
			case .form:
				LogInForm(server: server, isNew: $isNew, onBack: { page = .welcome }, onForgot: { page = .forgotPassword }) { page = .unverified($0) }
			case .forgotPassword:
				ForgotPassword(server: server) { page = .form }
			case let .unverified(email):
				AuthLayout(title: "Check your email", subtitle: "Open the link sent to \(email) to finish signing in.") {
					Button("Back") { page = .form }.buttonStyle(WebButtonStyle(variant: .secondary, size: .large, fullWidth: true))
				}
			}
		}
		.safeAreaInset(edge: .bottom, spacing: 0) {
			Button { choosingServer = true } label: {
				Text("Server: \(Self.host(of: server))")
					.font(Typeface.rubik(13))
					.foregroundStyle(Palette.subtleForeground)
					.padding(.vertical, 12)
					.frame(maxWidth: .infinity)
			}
			.buttonStyle(.plain)
			.accessibilityLabel("Server, \(Self.host(of: server))")
			.accessibilityHint("Changes the Sugabots server to sign in to")
		}
		.background(Palette.background.ignoresSafeArea())
		.onAppear {
			if server.isEmpty { server = session.server }
			#if DEBUG
			// A development build opens the page `SUGABOTS_OPEN` names, to screenshot it.
			switch DebugLaunch.target {
			case .signIn: page = .form
			case .signUp:
				isNew = true
				page = .form
			case .forgotPassword: page = .forgotPassword
			default: break
			}
			#endif
		}
		.fullScreenCover(isPresented: $choosingServer) {
			ServerSheet(server: server) { chosen in
				server = chosen
				choosingServer = false
			}
		}
	}

	private static func host(of server: String) -> String {
		let trimmed = server.trimmingCharacters(in: .whitespaces)
		let withScheme = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
		guard let url = URL(string: withScheme), let host = url.host() else { return trimmed.isEmpty ? "Not set" : trimmed }
		return url.port.map { "\(host):\($0)" } ?? host
	}
}

/// The first thing somebody new sees: a crowd of bots, the welcome, and Continue with email.
private struct Welcome: View {
	let onContinue: () -> Void

	/// A bot of each colour, each with its own eyes and a little up or down, as the design lines them up.
	private static let crowd: [(color: String, face: String, drop: CGFloat)] = [
		("rose", "dot", 12), ("yellow", "pill", -2), ("purple", "arc", 8), ("sky", "pill", -6),
		("green", "square", 10), ("orange", "wink", 2), ("ice", "arc", -4), ("teal", "dot", 8),
	]

	var body: some View {
		VStack(spacing: 22) {
			// As wide as the screen, the crowd cut off at its sides rather than widening the page.
			// Out past the page's 16-point inset to the screen's edges, clipped there.
			Color.clear
				.frame(maxWidth: .infinity)
				.frame(height: 52 + 2 * 12)
				.overlay {
					HStack(spacing: 12) {
						ForEach(Self.crowd, id: \.color) { bot in
							BotFace(look: BotLook(color: bot.color, face: bot.face, shape: "circle"), size: 52).offset(y: bot.drop)
						}
					}
					.fixedSize()
				}
				.clipped()
				.padding(.horizontal, -16)
				.padding(.bottom, 8)
				.accessibilityHidden(true)
			Text("Welcome to Sugabots")
				.font(Typeface.rubik(30, .bold))
				.tracking(-0.6)
				.foregroundStyle(Palette.foreground)
				.accessibilityAddTraits(.isHeader)
			Text("Bots that work alongside your team, in chats you already know how to use.")
				.font(Typeface.rubik(15))
				.lineSpacing(4)
				.foregroundStyle(Palette.mutedForeground)
			Button("Continue with email", action: onContinue)
				.buttonStyle(WebButtonStyle(size: .large, fullWidth: true))
				.padding(.top, 8)
		}
		.multilineTextAlignment(.center)
		.frame(maxWidth: 440)
		.padding(.horizontal, 16)
		.frame(maxWidth: .infinity, maxHeight: .infinity)
	}
}

/// Logging in, or making an account.
@MainActor
private struct LogInForm: View {
	let server: String
	@Binding var isNew: Bool
	let onBack: () -> Void
	let onForgot: () -> Void
	let onUnverified: (String) -> Void
	@Environment(Session.self) private var session
	@State private var name = ""
	@State private var email = ""
	@State private var password = ""
	@State private var error: String?
	@State private var busy = false

	var body: some View {
		AuthLayout(title: isNew ? "Create an account" : "Log in", onBack: onBack) {
			FormCard {
				if isNew {
					FormRow(label: "Name") {
						TextField("", text: $name)
							.textContentType(.name)
							.authField()
					}
				}
				FormRow(label: "Email") {
					TextField("", text: $email, prompt: Text(verbatim: "you@company.com").foregroundStyle(Palette.mutedForeground))
						.textContentType(.emailAddress)
						.keyboardType(.emailAddress)
						.textInputAutocapitalization(.never)
						.autocorrectionDisabled()
						.authField()
				}
				FormRow(label: "Password", last: true) {
					SecureField("", text: $password, prompt: isNew ? Text("8 characters or more").foregroundStyle(Palette.mutedForeground) : nil)
						.textContentType(isNew ? .newPassword : .password)
						.onSubmit(submit)
						.authField()
				}
			}
			if let error { FormAlert(text: error) }
			Button(isNew ? "Create account" : "Log in", action: submit)
				.buttonStyle(WebButtonStyle(size: .large, fullWidth: true))
				// As the web's form: only busy dims it; the fields say what they need when it's pressed.
				.disabled(busy)
			HStack(spacing: 24) {
				if !isNew {
					Button("Forgot password?", action: onForgot).buttonStyle(QuietLinkStyle())
				}
				Button(isNew ? "I already have an account" : "Create an account") { isNew.toggle() }
					.buttonStyle(QuietLinkStyle())
			}
			.frame(maxWidth: .infinity)
		}
	}

	/// What the web's `required` and `minLength` ask before the form can be sent.
	private var ready: Bool {
		!email.isEmpty && password.count >= 8 && (!isNew || !name.trimmingCharacters(in: .whitespaces).isEmpty)
	}

	private func submit() {
		guard !busy else { return }
		guard ready else {
			error = email.isEmpty ? "Enter your email." : password.count < 8 ? "Your password is 8 characters or more." : "Enter your name."
			return
		}
		busy = true
		error = nil
		Task {
			do {
				if isNew {
					if try await !session.signUp(server: server, name: name, email: email, password: password) {
						onUnverified(email)
					}
				} else {
					try await session.signIn(server: server, email: email, password: password)
				}
			} catch let failure as APIFailure where failure.isEmailUnverified {
				// Refusing this attempt has already resent the link.
				onUnverified(email)
			} catch {
				self.error = error.localizedDescription
			}
			busy = false
		}
	}
}

/// Asking for a link to choose a new password, as the web's `ForgotPassword`. The link opens the web app.
@MainActor
private struct ForgotPassword: View {
	let server: String
	let onBack: () -> Void
	@Environment(Session.self) private var session
	@State private var email = ""
	@State private var sentTo: String?
	@State private var error: String?
	@State private var busy = false

	var body: some View {
		if let sentTo {
			AuthLayout(title: "Check your email", subtitle: "If \(sentTo) has an account, a link to reset its password is on its way. It works for an hour.") {
				Button("Back to log in", action: onBack).buttonStyle(WebButtonStyle(variant: .secondary, size: .large, fullWidth: true))
			}
		} else {
			AuthLayout(title: "Reset your password", subtitle: "Enter the email you log in with and we'll send you a link to choose a new password.", onBack: onBack) {
				FormCard {
					FormRow(label: "Email", last: true) {
						TextField("", text: $email, prompt: Text(verbatim: "you@company.com").foregroundStyle(Palette.mutedForeground))
							.textContentType(.emailAddress)
							.keyboardType(.emailAddress)
							.textInputAutocapitalization(.never)
							.autocorrectionDisabled()
							.onSubmit(submit)
							.authField()
					}
				}
				if let error { FormAlert(text: error) }
				Button("Send reset link", action: submit)
					.buttonStyle(WebButtonStyle(size: .large, fullWidth: true))
					.disabled(busy)
			}
		}
	}

	private func submit() {
		guard !busy else { return }
		guard !email.isEmpty else {
			error = "Enter your email."
			return
		}
		busy = true
		error = nil
		Task {
			do {
				try await session.requestPasswordReset(server: server, email: email)
				sentTo = email
			} catch {
				self.error = error.localizedDescription
			}
			busy = false
		}
	}
}

/// Choosing the server to sign in to: the address Sugabots is opened at.
@MainActor
private struct ServerSheet: View {
	let server: String
	let chosen: (String) -> Void
	@Environment(Session.self) private var session
	@State private var draft = ""
	@State private var checking = false
	@State private var failure: String?

	var body: some View {
		DialogForm(title: "Server", action: checking ? "Checking…" : "Save", actionDisabled: checking || draft.trimmingCharacters(in: .whitespaces).isEmpty, gap: 12, submit: save) {
			SettingsGroup(note: "The address you open Sugabots at, such as sugabots.yourcompany.com.") {
				SettingsFieldRow(label: "Address", value: $draft, placeholder: "sugabots.example.com")
			}
			if let failure { FormAlert(text: failure) }
		}
		.onAppear { draft = server.replacingOccurrences(of: "https://", with: "") }
	}

	private func save() {
		let typed = draft.trimmingCharacters(in: .whitespaces)
		checking = true
		failure = nil
		Task {
			do {
				try await session.checkServer(typed)
				chosen(typed.contains("://") ? typed : "https://\(typed)")
			} catch {
				failure = error.localizedDescription
			}
			checking = false
		}
	}
}

// MARK: The web's AuthLayout

/// The frame the pages outside a workspace sit on, as the web's `AuthLayout`:
/// Back at the top left, then the title, a line under it, and the form, centred.
struct AuthLayout<Content: View>: View {
	let title: String
	var subtitle: String?
	var onBack: (() -> Void)?
	@ViewBuilder var content: Content

	var body: some View {
		VStack(spacing: 0) {
			HStack {
				if let onBack { TextBackButton(action: onBack) }
				Spacer()
			}
			.frame(minHeight: 20)
			.padding(.horizontal, 16)
			.padding(.top, 28)
			ScrollView {
				VStack(alignment: .leading, spacing: 14) {
					VStack(spacing: 10) {
						Text(title)
							.font(Typeface.rubik(30, .bold))
							.tracking(-0.6)
							.foregroundStyle(Palette.foreground)
							.accessibilityAddTraits(.isHeader)
						if let subtitle {
							Text(subtitle).font(Typeface.rubik(15)).lineSpacing(4).foregroundStyle(Palette.mutedForeground)
						}
					}
					.multilineTextAlignment(.center)
					.frame(maxWidth: .infinity)
					.padding(.bottom, 8)
					content
				}
				.frame(maxWidth: 440)
				.padding(.horizontal, 16)
				.padding(.vertical, 40)
				.frame(maxWidth: .infinity)
				.containerRelativeFrame(.vertical, alignment: .center) { height, _ in height }
			}
			.scrollBounceBehavior(.basedOnSize)
		}
	}
}

/// The form's card: its fields on the list colour.
struct FormCard<Content: View>: View {
	@ViewBuilder var content: Content

	var body: some View {
		VStack(spacing: 0) { content }
			.background(Palette.list, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
	}
}

/// One labelled field in the form's card.
struct FormRow<Field: View>: View {
	let label: String
	var last = false
	@ViewBuilder var field: Field

	var body: some View {
		HStack(spacing: 12) {
			Text(label).font(Typeface.rubik(14)).foregroundStyle(Palette.mutedForeground).frame(width: 88, alignment: .leading)
			field
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 14)
		.overlay(alignment: .bottom) {
			if !last { Rectangle().fill(Palette.border).frame(height: 1) }
		}
		.accessibilityElement(children: .combine)
	}
}

private extension View {
	/// A field as the form's card types it: 16 points, as a phone's fields are.
	func authField() -> some View {
		font(Typeface.rubik(16)).foregroundStyle(Palette.foreground)
	}
}
