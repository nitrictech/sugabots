import SwiftUI

/// Signing in or making an account, as the web's `Login`: the welcome first,
/// then the email form, with Forgot password and Create an account under it.
/// Between them the app asks which workspace, as Slack does, since it isn't
/// opened at the workspace's own address the way the web is.
@MainActor
struct SignInScreen: View {
	private enum Page {
		case welcome
		case workspace
		case form
		case forgotPassword
		/// The address of an account that exists but hasn't been proven.
		case unverified(String)
	}

	@Environment(Session.self) private var session
	@State private var page = Page.welcome
	@State private var isNew = false
	@State private var address = WorkspaceAddress(name: "", ending: WorkspaceAddress.hostedEnding)

	var body: some View {
		Group {
			switch page {
			case .welcome:
				Welcome { page = .workspace }
			case .workspace:
				WorkspaceStep(address: $address, onBack: { page = .welcome }) { page = .form }
			case .form:
				LogInForm(server: address.server, workspace: address.host, isNew: $isNew, onBack: { page = .workspace }, onForgot: { page = .forgotPassword }) { page = .unverified($0) }
			case .forgotPassword:
				ForgotPassword(server: address.server) { page = .form }
			case let .unverified(email):
				AuthLayout(title: "Check your email", subtitle: "Open the link sent to \(email) to finish signing in.") {
					Button("Back") { page = .form }.buttonStyle(WebButtonStyle(variant: .secondary, size: .large, fullWidth: true))
				}
			}
		}
		.background(Palette.background.ignoresSafeArea())
		.onAppear {
			// The workspace signed in to last, so signing in again is only Continue.
			if address.name.isEmpty, !session.server.isEmpty { address = WorkspaceAddress(server: session.server) }
			#if DEBUG
			// A development build opens the page `SUGABOTS_OPEN` names, to screenshot it.
			switch DebugLaunch.target {
			case .findWorkspace: page = .workspace
			case .signIn: page = .form
			case .signUp:
				isNew = true
				page = .form
			case .forgotPassword: page = .forgotPassword
			default: break
			}
			#endif
		}
	}
}

/// A workspace's address as sign-in asks for it: its name, then the ending of
/// the address its server is under. A hosted workspace is `[name].sugabots.ai`;
/// a self-hosted server has its own ending, such as `.yourcompany.com`.
struct WorkspaceAddress: Equatable {
	static let hostedEnding = ".sugabots.ai"

	var name: String
	var ending: String

	init(name: String, ending: String) {
		self.name = name
		self.ending = ending
	}

	/// Split from a whole address, such as a saved server or one pasted into the
	/// name: its first label is the name and the rest, with any port, the ending.
	init(server: String) {
		let withoutScheme = server.trimmingCharacters(in: .whitespaces).components(separatedBy: "://").last ?? ""
		let host = withoutScheme.split(separator: "/", maxSplits: 1).first.map(String.init) ?? ""
		guard let dot = host.firstIndex(of: ".") else {
			self.init(name: host, ending: Self.hostedEnding)
			return
		}
		self.init(name: String(host[..<dot]), ending: String(host[dot...]))
	}

	/// The name as typed, or its address's parts if a whole address was typed into it.
	var resolved: WorkspaceAddress {
		let typed = name.trimmingCharacters(in: .whitespaces)
		if typed.contains(".") || typed.contains("://") { return WorkspaceAddress(server: typed) }
		let trimmedEnding = ending.trimmingCharacters(in: .whitespaces)
		return WorkspaceAddress(name: typed, ending: trimmedEnding.hasPrefix(".") ? trimmedEnding : ".\(trimmedEnding)")
	}

	/// The workspace's host, with any port, such as `acme.sugabots.ai`.
	var host: String {
		let parts = resolved
		return (parts.name + parts.ending).lowercased()
	}

	var server: String { "https://\(host)" }
}

/// Which workspace to sign in to, as Slack asks: its name, before
/// `.sugabots.ai` or another ending for a self-hosted server.
@MainActor
private struct WorkspaceStep: View {
	@Binding var address: WorkspaceAddress
	let onBack: () -> Void
	let onFound: () -> Void
	@Environment(Session.self) private var session
	@State private var changingEnding = false
	@State private var checking = false
	@State private var failure: String?

	var body: some View {
		AuthLayout(title: "Your workspace", subtitle: "Enter the name of the workspace you sign in to.", onBack: onBack) {
			FormCard {
				FormRow(label: "Name", last: !changingEnding) {
					HStack(spacing: 0) {
						TextField("", text: $address.name, prompt: Text(verbatim: "your-team").foregroundStyle(Palette.mutedForeground))
							.textContentType(.URL)
							.keyboardType(.URL)
							.textInputAutocapitalization(.never)
							.autocorrectionDisabled()
							.onSubmit(check)
							.authField()
						if !changingEnding {
							Text(address.ending).authField().foregroundStyle(Palette.mutedForeground).lineLimit(1)
						}
					}
				}
				if changingEnding {
					FormRow(label: "Ending", last: true) {
						TextField("", text: $address.ending, prompt: Text(verbatim: ".yourcompany.com").foregroundStyle(Palette.mutedForeground))
							.keyboardType(.URL)
							.textInputAutocapitalization(.never)
							.autocorrectionDisabled()
							.onSubmit(check)
							.authField()
					}
				}
			}
			if let failure { FormAlert(text: failure) }
			Button(checking ? "Finding…" : "Continue", action: check)
				.buttonStyle(WebButtonStyle(size: .large, fullWidth: true))
				.disabled(checking)
			Button(changingEnding ? "Use \(WorkspaceAddress.hostedEnding)" : "My workspace isn't on \(WorkspaceAddress.hostedEnding)") {
				changingEnding.toggle()
				if !changingEnding { address.ending = WorkspaceAddress.hostedEnding }
			}
			.buttonStyle(QuietLinkStyle())
			.frame(maxWidth: .infinity)
		}
		.onAppear { changingEnding = address.ending != WorkspaceAddress.hostedEnding }
	}

	private func check() {
		guard !checking else { return }
		guard !address.resolved.name.isEmpty else {
			failure = "Enter your workspace's name."
			return
		}
		checking = true
		failure = nil
		Task {
			do {
				try await session.checkServer(address.server)
				onFound()
			} catch {
				failure = error.localizedDescription
			}
			checking = false
		}
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
	/// The workspace's host, said under the title so it's clear where this signs in.
	let workspace: String
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
		AuthLayout(title: isNew ? "Create an account" : "Log in", subtitle: "to \(workspace)", onBack: onBack) {
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
