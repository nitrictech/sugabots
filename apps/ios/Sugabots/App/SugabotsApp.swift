import SwiftUI

@main
@MainActor
struct SugabotsApp: App {
	@State private var session = Session()
	@State private var toaster = Toaster()
	@AppStorage(Theme.storageKey) private var theme = Theme.dark

	init() {
		Typeface.registerWebFonts()
	}

	var body: some Scene {
		WindowGroup {
			RootView()
				.environment(session)
				.environment(toaster)
				.font(Typeface.rubik(15))
				.foregroundStyle(Palette.foreground)
				.tint(Palette.foreground)
				.preferredColorScheme(theme.colorScheme)
		}
	}
}

/// Signing in, or the signed-in person's workspace. A view rather than the
/// scene's body, since only a view's body redraws when `Session` changes.
private struct RootView: View {
	@Environment(Session.self) private var session
	@Environment(Toaster.self) private var toaster

	var body: some View {
		ZStack(alignment: .bottom) {
			switch session.state {
			case .restoring:
				Palette.background.ignoresSafeArea()
					.task { await session.restore() }
			case .signedOut:
				SignInScreen()
			case let .settingUp(setup):
				OnboardingScreen(setup: setup)
			case let .signedIn(store):
				MainTabs()
					.environment(store)
					.id(store.workspace.id)
					.task { await store.start() }
			}
			ToastOverlay()
		}
		.animation(.easeOut(duration: 0.2), value: toaster.message)
		.background(Palette.background.ignoresSafeArea())
	}
}

/// The four tabs, each its own stack, under the design's floating glass bar.
struct MainTabs: View {
	enum Tab {
		case home, inbox, approvals, you
	}

	@Environment(WorkspaceStore.self) private var store
	@Environment(Session.self) private var session
	@Environment(\.scenePhase) private var scenePhase
	@State private var tab = Tab.home
	@State private var keyboardUp = false
	/// Each tab's pages over its root.
	@State private var paths: [Tab: [Route]] = [:]

	var body: some View {
		ZStack {
			TabStack(path: path(.home)) { HomeScreen().debugOpen() }.opacity(tab == .home ? 1 : 0).allowsHitTesting(tab == .home)
			TabStack(path: path(.inbox)) { InboxScreen() }.opacity(tab == .inbox ? 1 : 0).allowsHitTesting(tab == .inbox)
			TabStack(path: path(.approvals)) { ApprovalsScreen() }.opacity(tab == .approvals ? 1 : 0).allowsHitTesting(tab == .approvals)
			TabStack(path: path(.you)) { YouScreen() }.opacity(tab == .you ? 1 : 0).allowsHitTesting(tab == .you)
		}
		.task(id: store.agents.isEmpty) {
			// Setup's Start chatting opens the first bot's channel.
			guard let opening = session.botToOpen,
				let pod = store.pod(id: opening.podId),
				let agent = store.agent(id: opening.agentId)
			else { return }
			session.botToOpen = nil
			tab = .home
			paths[.home] = [.botChannel(pod, agent)]
		}
		#if DEBUG
		.task(id: store.pods.isEmpty) {
			guard let (openTab, route) = await DebugLaunch.destination(in: store) else { return }
			tab = openTab
			if let route { paths[openTab] = [route] }
		}
		#endif
		// The tabs float over every page, which scrolls on under them; while something is typed, the keyboard has the room.
		.overlay(alignment: .bottom) {
			if !keyboardUp {
				// Tapping the open tab again goes back to its first page, as iOS's own tab bars do.
				TabBar(tab: $tab) { reopened in paths[reopened] = [] }.offset(y: WindowInsets.tabBarSink)
			}
		}
		.environment(\.tabBarRoom, keyboardUp ? 0 : TabBar.room)
		// Every page opens on the open tab's own stack, so Back returns to where it was opened from.
		.environment(\.openPage, OpenPage { route in paths[tab, default: []].append(route) })
		.onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in keyboardUp = true }
		.onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboardUp = false }
		.onChange(of: scenePhase) { _, phase in
			// The stream may have been dropped while the app was away; what it missed is fetched again.
			if phase == .active { Task { await store.refreshAll() } }
		}
	}

	private func path(_ tab: Tab) -> Binding<[Route]> {
		Binding(get: { paths[tab] ?? [] }, set: { paths[tab] = $0 })
	}
}

/// One tab's stack, rooted at `root`, pushing every `Route` without a navigation bar: each page draws its own header.
private struct TabStack<Root: View>: View {
	@Binding var path: [Route]
	@ViewBuilder let root: Root

	var body: some View {
		NavigationStack(path: $path) {
			root
				.tabBarClearance()
				.toolbar(.hidden, for: .navigationBar)
				.background(Palette.background.ignoresSafeArea())
				.navigationDestination(for: Route.self) { route in
					RouteDestination(route: route)
				}
		}
	}
}

/// A stack of its own for a sheet or cover, rooted at `root`: pages opened
/// inside it push here, not onto the tab's stack hidden behind the sheet.
struct PageStack<Root: View>: View {
	@ViewBuilder let root: Root
	@State private var path: [Route] = []

	var body: some View {
		NavigationStack(path: $path) {
			root.navigationDestination(for: Route.self) { route in
				RouteDestination(route: route)
			}
		}
		.environment(\.openPage, OpenPage { route in path.append(route) })
	}
}

/// The page a `Route` opens, without a navigation bar: each page draws its own header.
struct RouteDestination: View {
	let route: Route

	var body: some View {
		page
			.tabBarClearance()
			.toolbar(.hidden, for: .navigationBar)
			.background(Palette.background.ignoresSafeArea())
	}

	@ViewBuilder private var page: some View {
		switch route {
		case let .podChat(pod): OpeningConversationScreen.podChat(pod)
		case let .botChannel(pod, agent): OpeningConversationScreen.botChannel(agent, in: pod)
		case let .newThread(pod, agent): NewThreadScreen(pod: pod, agent: agent)
		case let .podSettings(pod): PodSettingsScreen(pod: pod)
		case let .conversation(threadId, title): ConversationScreen(threadId: threadId, title: title)
		case let .approval(callId): ApprovalPage(callId: callId)
		case let .conversationAt(threadId, messageId): ConversationScreen(threadId: threadId, title: "", focusMessageId: messageId)
		case let .sideThreadPage(conversationId, threadId): SideThreadSheet(threadId: threadId, conversationId: conversationId, entry: nil, chatAgentId: nil, asPage: true) { _ in }
		case let .routines(pod, agent): RoutinesScreen(pod: pod, agent: agent)
		case let .newRoutine(pod, agent): NewRoutineScreen(pod: pod, agent: agent)
		case let .routine(pod, routineId): OpeningConversationScreen.routineFeed(routineId, in: pod)
		case let .artifacts(pod): ArtifactsScreen(pod: pod)
		case let .artifact(podId, artifactId, version): ArtifactScreen(podId: podId, artifactId: artifactId, version: version)
		case let .settings(place): SettingsDestination(place: place)
		case let .details(model): ConversationDetails(model: model)
		}
	}
}

/// Home, Inbox, Approvals and You, floating along the foot of the screen,
/// as the web's `MobileTabBar`: the open tab marked by a highlight that
/// slides from tab to tab, Inbox counting what is unread and Approvals what
/// waits on you.
private struct TabBar: View {
	@Binding var tab: MainTabs.Tab
	/// The open tab, tapped again.
	let reopen: (MainTabs.Tab) -> Void
	@Environment(WorkspaceStore.self) private var store

	private static let tabs: [MainTabs.Tab] = [.home, .inbox, .approvals, .you]
	/// What the bar takes at the foot of a page, over the safe area: itself, 60
	/// tall, and 8 over it, less how far it sinks into the safe area below.
	@MainActor static var room: CGFloat { 68 - WindowInsets.tabBarSink }
	private static let gap: CGFloat = 2

	var body: some View {
		let index = CGFloat(Self.tabs.firstIndex(of: tab) ?? 0)
		HStack(spacing: Self.gap) {
			item(.home, "Home") { Icon(.house, size: 24, strokeWidth: 1.75) }
			item(.inbox, "Inbox", count: store.unreadInInbox, label: "\(store.unreadInInbox) unread") {
				Icon(.inbox, size: 24, strokeWidth: 1.75)
			}
			item(.approvals, "Approvals", count: store.waitingApprovals, label: "\(store.waitingApprovals) waiting on you") {
				Icon(.shieldCheck, size: 24, strokeWidth: 1.75)
			}
			item(.you, "You") {
				PersonAvatar(name: store.user.name, email: store.user.email, image: store.user.image, size: 24)
					.overlay(Circle().strokeBorder(Palette.foreground, lineWidth: tab == .you ? 1.5 : 0))
			}
		}
		.background(alignment: .leading) {
			GeometryReader { geometry in
				let width = (geometry.size.width - Self.gap * 3) / 4
				RoundedRectangle(cornerRadius: 26, style: .continuous)
					.fill(Palette.hover)
					.frame(width: width)
					.offset(x: index * (width + Self.gap))
					.animation(.easeOut(duration: 0.3), value: tab)
			}
		}
		.padding(5)
		.glass(in: RoundedRectangle(cornerRadius: 32, style: .continuous))
		// The web's glass, which keeps the highlight under the open tab visible.
		.environment(\.glassStyle, .web)
		.padding(.horizontal, barSideInset)
		.padding(.top, 8)
	}

	/// One tab: its icon and name, bright while open, with a count over the icon's corner.
	private func item(
		_ target: MainTabs.Tab,
		_ name: String,
		count: Int = 0,
		label: String = "",
		quiet: Bool = false,
		@ViewBuilder icon: () -> some View
	) -> some View {
		let open = tab == target
		return Button { if open { reopen(target) } else { tab = target } } label: {
			VStack(spacing: 3) {
				icon()
					.frame(width: 24, height: 24)
					// Pinned to the icon's corner, so it sits the same on every tab whatever its name's width.
					.overlay(alignment: .topLeading) {
						if count > 0 {
							CountBadge(count: count, quiet: quiet)
								.fixedSize()
								.alignmentGuide(.leading) { _ in -14 }
								.alignmentGuide(.top) { _ in 6 }
						}
					}
				Text(name).font(Typeface.rubik(10, .medium))
			}
			.foregroundStyle(open ? Palette.foreground : Palette.mutedForeground)
			.frame(maxWidth: .infinity, minHeight: 50)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityLabel(count > 0 ? "\(name), \(label)" : name)
		.accessibilityAddTraits(open ? .isSelected : [])
	}
}

private struct TabBarRoomKey: EnvironmentKey {
	static let defaultValue: CGFloat = 0
}

extension EnvironmentValues {
	/// How much of a page's foot the floating tabs cover, while they show.
	var tabBarRoom: CGFloat {
		get { self[TabBarRoomKey.self] }
		set { self[TabBarRoomKey.self] = newValue }
	}
}

private struct TabBarClearance: ViewModifier {
	@Environment(\.tabBarRoom) private var room

	func body(content: Content) -> some View {
		content.safeAreaPadding(.bottom, room)
	}
}

extension View {
	/// Leaves the floating tabs their room at the page's foot, so what scrolls comes clear of them.
	func tabBarClearance() -> some View {
		modifier(TabBarClearance())
	}
}

/// Pushes a page onto the stack it is called in: the open tab's, or a
/// sheet's `PageStack`. Pages open this way, not with a
/// `navigationDestination` of their own: a page pushed beside the stack's path
/// can't push onto that path itself, so its links would do nothing.
struct OpenPage {
	let open: (Route) -> Void

	func callAsFunction(_ route: Route) { open(route) }
}

private struct OpenPageKey: EnvironmentKey {
	static let defaultValue = OpenPage { _ in }
}

extension EnvironmentValues {
	var openPage: OpenPage {
		get { self[OpenPageKey.self] }
		set { self[OpenPageKey.self] = newValue }
	}
}
