#if DEBUG
import Foundation

/// What a development build opens at launch, from its launch environment, so
/// it can be screenshotted at any page without tapping.
///
/// `SUGABOTS_OPEN` names a page as `page[/Pod name[/detail]]`; see `Target`.
/// The other variables are read through `once`.
enum DebugLaunch {
	/// A page `SUGABOTS_OPEN` names. A pod is named by its name and a bot by its name within the pod.
	enum Target {
		// Tabs.
		/// `inbox`, `approvals`, `you`.
		case inbox, approvals, you

		// Signing in, before there's an account.
		/// `findworkspace`, `login`, `signup`, `forgot`.
		case findWorkspace, signIn, signUp, forgotPassword

		// Home, over the pod.
		/// `pod/Pod`: Home on the pod.
		case home(pod: String)
		/// `general/Pod`.
		case general(pod: String)
		/// `bot/Pod/Bot`: the bot's channel.
		case bot(pod: String, bot: String)
		/// `threads/Pod/Bot`: the bot's threads.
		case threads(pod: String, bot: String)
		/// `newthread/Pod[/Bot]`.
		case newThread(pod: String, bot: String?)
		/// `conversation/<id>`.
		case conversation(id: String)
		/// `settings/Pod`: the pod's settings, pushed on Home.
		case podSettings(pod: String)
		/// `routines/Pod`, `newRoutine/Pod`, `artifacts/Pod`, `newBot/Pod`.
		case routines(pod: String), newRoutine(pod: String), artifacts(pod: String), newBot(pod: String)
		/// `routinePanel/Pod[/rename|instructions|delete|trigger|webhook]`: the pod's first routine, perhaps with a dialog open.
		case routinePanel(pod: String, dialog: String?)
		/// `trigger/Pod[/kinds|cron|webhook|github]`: adding a trigger, at its kinds or a new one of a kind.
		case trigger(pod: String, kind: String?)
		/// `emoji/Pod[/full]`: the emoji picker, perhaps at its full list.
		case emoji(pod: String, full: Bool)

		// Settings, pushed on You.
		/// `profile`, `notifications`, `member` (the workspace's first).
		case profile, notifications, member
		/// A workspace section by its name: `members`, `providers`, …
		case workspace(WorkspaceSection)
		/// `youpod/Pod`: the pod as You lists it.
		case youPod(pod: String)
		/// `pod/Pod/<page>`: one of the pod's settings pages, such as `connections`.
		case podPage(pod: String, page: PodSettingsPage)
		/// `agent/Pod/Bot`: the bot's settings.
		case agentSettings(pod: String, bot: String)

		/// The name of the pod the page is in, if it's in one.
		var podName: String? {
			switch self {
			case let .home(pod), let .general(pod), let .bot(pod, _), let .threads(pod, _), let .newThread(pod, _), let .podSettings(pod),
				let .routines(pod), let .newRoutine(pod), let .artifacts(pod), let .newBot(pod),
				let .routinePanel(pod, _), let .trigger(pod, _), let .emoji(pod, _),
				let .youPod(pod), let .podPage(pod, _), let .agentSettings(pod, _):
				pod
			case .inbox, .approvals, .you, .findWorkspace, .signIn, .signUp, .forgotPassword, .conversation,
				.profile, .notifications, .member, .workspace:
				nil
			}
		}

		/// The page `value` names, or nil if it names none.
		static func parse(_ value: String) -> Target? {
			let parts = value.split(separator: "/").map(String.init)
			guard let page = parts.first else { return nil }
			let pod = parts.count > 1 ? parts[1] : nil
			let detail = parts.count > 2 ? parts[2] : nil
			switch (page, pod, detail) {
			case ("inbox", _, _): return .inbox
			case ("approvals", _, _): return .approvals
			case ("you", _, _): return .you
			case ("findworkspace", _, _): return .findWorkspace
			case ("login", _, _): return .signIn
			case ("signup", _, _): return .signUp
			case ("forgot", _, _): return .forgotPassword
			case ("profile", _, _): return .profile
			case ("notifications", _, _): return .notifications
			case ("member", _, _): return .member
			case let ("conversation", id?, _): return .conversation(id: id)
			case let ("pod", pod?, page?): return PodSettingsPage(rawValue: page).map { .podPage(pod: pod, page: $0) }
			case let ("pod", pod?, nil): return .home(pod: pod)
			case let ("general", pod?, _): return .general(pod: pod)
			case let ("bot", pod?, bot?): return .bot(pod: pod, bot: bot)
			case let ("threads", pod?, bot?): return .threads(pod: pod, bot: bot)
			case let ("newthread", pod?, bot): return .newThread(pod: pod, bot: bot)
			case let ("settings", pod?, _): return .podSettings(pod: pod)
			case let ("routines", pod?, _): return .routines(pod: pod)
			case let ("newRoutine", pod?, _): return .newRoutine(pod: pod)
			case let ("artifacts", pod?, _): return .artifacts(pod: pod)
			case let ("newBot", pod?, _): return .newBot(pod: pod)
			case let ("routinePanel", pod?, dialog): return .routinePanel(pod: pod, dialog: dialog)
			case let ("trigger", pod?, kind): return .trigger(pod: pod, kind: kind)
			case let ("emoji", pod?, list): return .emoji(pod: pod, full: list == "full")
			case let ("youpod", pod?, _): return .youPod(pod: pod)
			case let ("agent", pod?, bot?): return .agentSettings(pod: pod, bot: bot)
			case let (section, nil, nil): return WorkspaceSection(rawValue: section).map(Target.workspace)
			default: return nil
			}
		}
	}

	private static let environment = ProcessInfo.processInfo.environment

	/// The page `SUGABOTS_OPEN` names, if any.
	static let target = environment["SUGABOTS_OPEN"].flatMap(Target.parse)

	/// The variables of the launch environment `once` has answered true for.
	@MainActor private static var taken: Set<String> = []

	/// Whether the launch environment sets `variable` to `value`, answering
	/// true only the first time it is asked, so what it asks for happens once a
	/// launch, not each time its page appears: `SUGABOTS_TYPING=1` gives the
	/// first conversation's composer the keyboard, `SUGABOTS_DETAILS=1` opens
	/// Details over it, `SUGABOTS_HOLD=1` holds a message open, and
	/// `SUGABOTS_SHEET` names a sheet a settings page opens over itself:
	/// `invite`, `timezone`, `addconnection` or `look`.
	@MainActor static func once(_ variable: String, is value: String = "1") -> Bool {
		guard environment[variable] == value, !taken.contains(variable) else { return false }
		taken.insert(variable)
		return true
	}

	/// The pod the target is in, once the workspace has loaded it.
	@MainActor
	static func targetPod(in store: WorkspaceStore) -> Pod? {
		guard let name = target?.podName else { return nil }
		return store.pods.first { $0.name == name }
	}

	/// The bot named `name` in `pod`.
	@MainActor
	static func bot(named name: String, in pod: Pod, store: WorkspaceStore) -> Agent? {
		store.agents.first { $0.podId == pod.id && $0.name == name }
	}

	/// The tab to show, and the page to push on it, for a target that is one;
	/// nil for any other. A page in a pod is pushed on Home; a settings page on You.
	@MainActor
	static func destination(in store: WorkspaceStore) async -> (MainTabs.Tab, Route?)? {
		guard let target, !store.pods.isEmpty else { return nil }
		let pod = targetPod(in: store)
		switch target {
		case .inbox: return (.inbox, nil)
		case .approvals: return (.approvals, nil)
		case .you: return (.you, nil)
		case let .conversation(id): return (.home, .conversation(threadId: id, title: ""))
		case .home: return pod.map { _ in (.home, nil) }
		case .general: return pod.map { (.home, .podChat($0)) }
		case let .bot(_, name):
			guard let pod, let bot = bot(named: name, in: pod, store: store) else { return nil }
			return (.home, .botChannel(pod, bot))
		case let .threads(_, name):
			guard let pod, let bot = bot(named: name, in: pod, store: store) else { return nil }
			return (.home, .threads(pod, agent: bot))
		case let .newThread(_, name):
			guard let pod else { return nil }
			return (.home, .newThread(pod, agent: name.flatMap { bot(named: $0, in: pod, store: store) }))
		case .podSettings: return pod.map { (.home, .podSettings($0)) }
		case .routines: return pod.map { (.home, .routines($0, agent: nil)) }
		case .newRoutine: return pod.map { (.home, .newRoutine($0, agent: nil)) }
		case .artifacts: return pod.map { (.home, .artifacts($0)) }
		case .profile: return (.you, .settings(.profile))
		case .notifications: return (.you, .settings(.notifications))
		case let .workspace(section): return (.you, .settings(.workspace(section)))
		case .member:
			guard let first = try? await store.workspaceMembers().first else { return nil }
			return (.you, .settings(.member(id: first.id)))
		case .youPod: return pod.map { (.you, .settings(.pod($0))) }
		case let .podPage(_, page): return pod.map { (.you, .settings(.podPage($0, page))) }
		case let .agentSettings(_, name):
			guard let pod, let agent = bot(named: name, in: pod, store: store) else { return nil }
			return (.you, .settings(.agent(pod, agent)))
		case .findWorkspace, .signIn, .signUp, .forgotPassword, .newBot, .routinePanel, .trigger, .emoji:
			// Signing in opens its own pages, and these open over Home (see `debugOpen()`).
			return nil
		}
	}
}
#endif
