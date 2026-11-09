import Foundation
import Observation
import UIKit
import UserNotifications

/// Notifications pushed to this phone through Apple, which show while the app
/// is closed: whether the person allowed them and turned them on here, this
/// install's token, which the server keeps on the signed-in session (so
/// signing out ends them), whether the server can push to the app at all, and
/// what a tapped one opens.
///
/// Turning them off here keeps iOS's permission, as the web keeps a browser's,
/// and only tells the server to stop. It is remembered for the account that
/// turned them off, not for whoever signs in on the phone next. Turning off
/// iOS's permission tells the server to stop too, the next time the app opens.
@MainActor
@Observable
final class PushNotifications {
	enum Permission {
		case undetermined, denied, granted
	}

	/// Which of Apple's services this build's tokens belong to: a debug build
	/// is signed for the sandbox, a TestFlight or App Store build for production.
	#if DEBUG
	static let environment = ApnsEnvironment.development
	#else
	static let environment = ApnsEnvironment.production
	#endif

	/// How often the server is told of a phone it already holds, which keeps its session going.
	private static let registrationRenewal: TimeInterval = 24 * 60 * 60

	private static let turnedOffAccountsKey = "pushNotificationsTurnedOffAccounts"

	private(set) var permission = Permission.undetermined
	/// This install's token from Apple, once it has registered.
	private(set) var deviceToken: String?
	/// Whether the signed-in server can push to the app, once it has said; it can't without Apple's key.
	private(set) var availableOnServer: Bool?
	/// The signed-in account, as `account(server:userId:)` names it.
	private var account: String?
	/// The accounts that turned them off on this phone after allowing them.
	private var turnedOffAccounts = Set(UserDefaults.standard.stringArray(forKey: turnedOffAccountsKey) ?? [])
	/// What the server last took from this phone, so it is told again only when that changes or goes stale.
	private var registration = Registration.saved
	/// What a tapped notification opens, until the open workspace takes it.
	var opened: NotificationTarget?
	/// The conversation on screen, whose notifications don't show while the app is open on it.
	var conversationOnScreen: String?

	var isOn: Bool {
		permission == .granted && availableOnServer != false && !(account.map(turnedOffAccounts.contains) ?? false)
	}

	/// One person on one server, which is what turning notifications off is remembered for.
	static func account(server: URL, userId: String) -> String {
		"\(server.absoluteString) \(userId)"
	}

	/// Brings the server up to date for `account`, signed in through `client`:
	/// reads the permission, asking for it the first time, registers with
	/// Apple while notifications are on, and tells the server of the token, or
	/// that they are now off. Each launch, each token Apple gives, and each
	/// time the app comes back to the front, so a failed attempt is retried.
	func update(for account: String, with client: APIClient) async {
		if self.account != account { availableOnServer = nil }
		self.account = account
		await readPermission()
		if permission == .undetermined { await askPermission() }
		if isOn { UIApplication.shared.registerForRemoteNotifications() }
		try? await sync(with: client, account: account)
	}

	/// Turns them on here, asking iOS first if it hasn't been asked, and tells the server.
	func turnOn(with client: APIClient) async throws {
		guard let account else { return }
		if permission == .undetermined { await askPermission() }
		guard permission == .granted else { return }
		setTurnedOff(false, for: account)
		UIApplication.shared.registerForRemoteNotifications()
		registration = nil
		try await sync(with: client, account: account)
	}

	/// Tells the server to stop pushing to this phone, then remembers they are off.
	func turnOff(with client: APIClient) async throws {
		guard let account else { return }
		try await client.notifications.unregisterDevice()
		save(registration: nil)
		setTurnedOff(true, for: account)
	}

	/// Reads the permission again, which the person can change in iOS's Settings while the app is away.
	func readPermission() async {
		let settings = await UNUserNotificationCenter.current().notificationSettings()
		permission = switch settings.authorizationStatus {
		case .authorized, .provisional, .ephemeral: .granted
		case .denied: .denied
		default: .undetermined
		}
	}

	fileprivate func registered(_ token: Data) {
		deviceToken = token.map { String(format: "%02x", $0) }.joined()
	}

	/// Tells the server of this phone's token while they are on, unless it
	/// took this token for `account` within the day, or that they are off
	/// if it holds the phone for `account`.
	private func sync(with client: APIClient, account: String) async throws {
		guard isOn else {
			guard registration?.account == account else { return }
			try await client.notifications.unregisterDevice()
			save(registration: nil)
			return
		}
		guard let deviceToken else { return }
		if let registration, registration.account == account, registration.token == deviceToken,
			Date().timeIntervalSince(registration.at) < Self.registrationRenewal
		{
			return
		}
		let answer = try await client.notifications.registerDevice(
			body: .apns(ApnsDevice(token: deviceToken, environment: Self.environment))
		)
		availableOnServer = answer.available
		save(registration: answer.available ? Registration(account: account, token: deviceToken, at: Date()) : nil)
	}

	private func askPermission() async {
		// No badge: the app doesn't keep a count on its icon.
		_ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
		await readPermission()
	}

	private func setTurnedOff(_ off: Bool, for account: String) {
		if off { turnedOffAccounts.insert(account) } else { turnedOffAccounts.remove(account) }
		UserDefaults.standard.set(Array(turnedOffAccounts), forKey: Self.turnedOffAccountsKey)
	}

	private func save(registration: Registration?) {
		self.registration = registration
		Registration.save(registration)
	}

	/// The token the server took for an account, and when.
	private struct Registration: Codable {
		private static let key = "pushNotificationsRegistration"

		let account: String
		let token: String
		let at: Date

		static var saved: Registration? {
			UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(Registration.self, from: $0) }
		}

		static func save(_ registration: Registration?) {
			UserDefaults.standard.set(registration.flatMap { try? JSONEncoder().encode($0) }, forKey: key)
		}
	}
}

/// Takes Apple's token and the notifications iOS hands the app, for `push`.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
	let push = PushNotifications()

	func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
		// Set before launch finishes, so a tap that launched the app reaches it.
		UNUserNotificationCenter.current().delegate = self
		return true
	}

	func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
		push.registered(deviceToken)
	}

	func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
		// Without a token the phone is only notified while the app is open; Settings still shows them on.
		print("Couldn't register for push notifications: \(error.localizedDescription)")
	}

	/// Shows a notification that arrives while the app is open, unless it is about the conversation on screen.
	func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
		let conversationId = notification.request.content.userInfo["conversationId"] as? String
		let onScreen = await MainActor.run { push.conversationOnScreen }
		return conversationId != nil && conversationId == onScreen ? [] : [.banner, .list, .sound]
	}

	func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
		let path = response.notification.request.content.userInfo["path"] as? String
		await MainActor.run { push.opened = path.flatMap(NotificationTarget.init(path:)) }
	}
}

/// The page a notification opens, read from the web path the server gives
/// it, as the Inbox opens the same item: a message in its conversation, a
/// routine run's thread, or an approval, under the tab the web shows it in.
struct NotificationTarget: Hashable {
	let workspaceSlug: String
	let tab: MainTabs.Tab
	/// The page over the tab's first, or nil for the tab itself.
	let route: Route?

	/// Reads `/workspace/activity/pod/conversation?message=…` or `?threadPage=…`,
	/// and `/workspace/approvals/call`; nil for any other path.
	init?(path: String) {
		guard let components = URLComponents(string: path) else { return nil }
		let parts = components.path.split(separator: "/").map(String.init)
		let query = Dictionary((components.queryItems ?? []).map { ($0.name, $0.value ?? "") }) { first, _ in first }
		switch parts.dropFirst().first {
		case "activity" where parts.count == 4:
			let conversationId = parts[3]
			workspaceSlug = parts[0]
			tab = .inbox
			if let messageId = query["message"] {
				route = .conversationAt(threadId: conversationId, messageId: messageId)
			} else if let threadId = query["threadPage"] {
				route = .sideThreadPage(conversationId: conversationId, threadId: threadId)
			} else {
				route = .conversation(threadId: conversationId, title: "")
			}
		case "approvals" where parts.count == 3:
			workspaceSlug = parts[0]
			tab = .approvals
			route = .approval(callId: parts[2])
		default:
			return nil
		}
	}
}
