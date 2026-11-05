import SwiftUI

// What starts a routine, as the web's `RoutineTriggers`, `RoutineTriggerKinds`,
// `RoutineSchedule`, `RoutineWebhook` and `RoutineRepository`: a list of its
// triggers, each opening a sheet to change it, and Add trigger, which
// chooses the kind and then sets it up.

extension TriggerInput {
	var triggerKind: TriggerKind {
		switch self {
		case .cron: .cron
		case .webhook: .webhook
		case .github: .github
		}
	}
}

extension RoutineTrigger {
	/// Its kind, or nil for a kind from a newer server than this app knows.
	var triggerKind: TriggerKind? {
		switch self {
		case .cron: .cron
		case .webhook: .webhook
		case .github: .github
		case .unknown: nil
		}
	}
}

/// A kind of trigger's mark: its integration's logo, or an icon for Sugabots' own.
struct TriggerKindMark: View {
	let kind: TriggerKind

	var body: some View {
		if let connection = kind.connection {
			ConnectionMark(presetId: connection.rawValue, name: kind.label, size: .tile)
		} else {
			Icon(kind == .cron ? .clock : .webhook, size: 15, strokeWidth: 2.2)
				.foregroundStyle(Palette.softForeground)
				.frame(width: 34, height: 34)
				.overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.borderStrong))
				.accessibilityHidden(true)
		}
	}
}

/// A trigger as written in a sheet, before it is saved.
enum TriggerDraft: Hashable {
	case cron(reading: ScheduleReading, timezone: String)
	case webhook(WebhookDraft)
	case github(RepositoryDraft)

	/// A new trigger of `kind`, as it starts: a daily schedule, a signed webhook, a repository to pick.
	static func new(_ kind: TriggerKind) -> TriggerDraft {
		switch kind {
		case .cron: .cron(reading: .picked(ScheduleWords.defaultSchedule()), timezone: TimeZone.current.identifier)
		case .webhook: .webhook(WebhookDraft())
		case .github: .github(RepositoryDraft())
		}
	}

	/// `trigger` as a draft to change. A webhook's secret is changed apart from it, so it starts blank.
	static func of(_ trigger: TriggerInput) -> TriggerDraft {
		switch trigger {
		case let .cron(schedule, timezone): .cron(reading: ScheduleWords.read(schedule), timezone: timezone)
		case let .webhook(auth, secret): .webhook(WebhookDraft(auth: auth, secret: secret ?? ""))
		case let .github(connectionId, repository, events):
			.github(RepositoryDraft(connectionId: connectionId, repository: repository, events: events))
		}
	}

	var kind: TriggerKind {
		switch self {
		case .cron: .cron
		case .webhook: .webhook
		case .github: .github
		}
	}

	/// What the draft saves as, or why it can't be saved yet.
	var written: Result<TriggerInput, NotReady> {
		switch self {
		case let .cron(reading, timezone):
			return ScheduleWords.ready(reading)
				? .success(.cron(schedule: ScheduleWords.scheduleOf(reading), timezone: timezone))
				: .failure(NotReady(note: "Pick at least one day for it to run on."))
		case let .webhook(draft):
			guard draft.secretReady else { return .failure(NotReady(note: WebhookDraft.secretTooShortNote)) }
			let trimmed = draft.secret.trimmingCharacters(in: .whitespaces)
			return .success(.webhook(auth: draft.auth, secret: trimmed.isEmpty ? nil : trimmed))
		case let .github(draft):
			guard let connectionId = draft.connectionId, let repository = draft.repository else {
				return .failure(NotReady(note: "Pick the repository it runs on."))
			}
			guard !draft.events.isEmpty else { return .failure(NotReady(note: RepositoryDraft.pickAnEventNote)) }
			return .success(.github(connectionId: connectionId, repository: repository, events: draft.events))
		}
	}

	struct NotReady: Error, Hashable {
		let note: String
	}
}

/// A routine's triggers, each opening it to change, then Add trigger, for someone who may change them.
struct TriggersGroup: View {
	let triggers: [(key: String, trigger: TriggerInput)]
	let editable: Bool
	var note: String?
	let open: (String) -> Void
	let add: () -> Void

	var body: some View {
		SettingsGroup(label: "Triggers", note: note) {
			if triggers.isEmpty {
				SettingsRow(label: "No triggers", sub: "It runs only when someone runs it.")
				if editable { SettingsDivider() }
			}
			DividedRows(data: triggers, id: \.key) { listed in
				let row = SettingsRow(
					label: ScheduleWords.triggerLabel(listed.trigger),
					sub: listed.trigger.triggerKind.label,
					chevron: editable,
					leading: { TriggerKindMark(kind: listed.trigger.triggerKind) }
				)
				if editable {
					Button { open(listed.key) } label: { row }.buttonStyle(SettingsRowPressStyle())
				} else {
					row
				}
			}
			if editable {
				if !triggers.isEmpty { SettingsDivider() }
				SettingsAddRow(label: "Add trigger", action: add)
			}
		}
	}
}

/// Adding a trigger, a step at a time: its kind, then setting it up; or
/// changing one, straight at the second step, with Remove. The sheet closes
/// once its action or `remove` finishes, and says why when they fail.
struct TriggerSheet<Settings: View>: View {
	/// How the sheet's step sets the trigger up.
	enum Mode {
		/// Every setting is written in a draft, which Add trigger or Save hands to `save`.
		case draft(save: (TriggerInput) async throws -> Void)
		/// `settings` in place of a draft's groups, for an existing trigger whose
		/// settings save as they change, such as a webhook's auth and secret; the
		/// sheet's action is Done.
		case savesItself(Settings)
	}

	/// The bot's pod, whose connections decide which integrations' triggers it may have.
	let pod: Pod
	/// The trigger being changed, as a draft; nil while adding one.
	let editing: TriggerDraft?
	let mode: Mode
	var remove: (() async throws -> Void)?
	@Environment(\.dismiss) private var dismiss
	@State private var draft: TriggerDraft?
	@State private var pending = false
	@State private var failure: String?

	var body: some View {
		Group {
			if let draft {
				DialogForm(
					title: draft.kind.label,
					onBack: editing == nil && !pending ? { self.draft = nil } : nil,
					closable: !pending,
					gap: 20
				) {
					switch mode {
					case .draft:
						DraftGroups(pod: pod, draft: Binding(get: { draft }, set: { self.draft = $0 }))
					case let .savesItself(settings):
						settings
					}
					if let failure { FormAlert(text: failure) }
				}
				.safeAreaInset(edge: .bottom, spacing: 0) {
					// Remove beside the action, each half the width, as the web's footer on a phone.
					HStack(spacing: 8) {
						if let remove {
							Button("Remove") { settle(remove) }
								.buttonStyle(WebButtonStyle(variant: .secondary, size: .phone))
								.disabled(pending)
						}
						action(for: draft)
					}
					.padding(.horizontal, 16)
					.padding(.top, 12)
					.padding(.bottom, 16)
					.background(Palette.panel)
				}
			} else {
				TriggerKindStep(pod: pod) { kind in draft = .new(kind) }
			}
		}
		.onAppear { if draft == nil { draft = editing } }
	}

	/// The footer's main button: Add trigger or Save for a draft, once it is ready; Done for settings that save themselves.
	@ViewBuilder private func action(for draft: TriggerDraft) -> some View {
		switch mode {
		case let .draft(save):
			let written = draft.written
			Button(editing == nil ? "Add trigger" : "Save") {
				guard case let .success(input) = written else { return }
				settle { try await save(input) }
			}
			.buttonStyle(WebButtonStyle(size: .phone))
			.disabled(pending || (try? written.get()) == nil)
		case .savesItself:
			Button("Done") { dismiss() }
				.buttonStyle(WebButtonStyle(size: .phone))
				.disabled(pending)
		}
	}

	private func settle(_ action: @escaping () async throws -> Void) {
		pending = true
		failure = nil
		Task {
			do {
				try await action()
				dismiss()
			} catch {
				failure = error.localizedDescription
				pending = false
			}
		}
	}
}

extension TriggerSheet where Settings == EmptyView {
	/// A sheet that writes the trigger as a draft and hands it to `save`.
	init(pod: Pod, editing: TriggerDraft?, save: @escaping (TriggerInput) async throws -> Void, remove: (() async throws -> Void)? = nil) {
		self.init(pod: pod, editing: editing, mode: .draft(save: save), remove: remove)
	}
}

/// The groups that set up a draft of its kind, under what it still needs or what it does.
private struct DraftGroups: View {
	let pod: Pod
	@Binding var draft: TriggerDraft

	var body: some View {
		let notReady: String? = if case let .failure(reason) = draft.written { reason.note } else { nil }
		switch draft {
		case let .cron(reading, timezone):
			ScheduleGroups(reading: reading, note: notReady ?? ScheduleWords.note(reading, timezone: timezone)) { schedule in
				draft = .cron(reading: .picked(schedule), timezone: timezone)
			}
		case let .webhook(webhook):
			NewWebhookGroups(
				draft: Binding(get: { webhook }, set: { draft = .webhook($0) }),
				note: notReady ?? (webhook.secret.trimmingCharacters(in: .whitespaces).isEmpty ? WebhookDraft.noSecretNote : webhook.auth.note)
			)
		case let .github(repository):
			RepositoryGroups(pod: pod, draft: Binding(get: { repository }, set: { draft = .github($0) }))
		}
	}
}

/// The first step of adding a trigger: choosing its kind, found by typing part
/// of its name, from Sugabots' own and those of the integrations `pod` is
/// connected to, with a way to connect it to more.
private struct TriggerKindStep: View {
	let pod: Pod
	let choose: (TriggerKind) -> Void
	@Environment(WorkspaceStore.self) private var store
	@State private var query = ""
	@State private var connected: Set<ConnectionKind> = []
	@State private var connectionsFailure: String?
	@State private var openedSettings: Pod?

	var body: some View {
		let typed = query.trimmingCharacters(in: .whitespaces)
		let needle = typed.lowercased()
		let matches = { (kind: TriggerKind) in
			needle.isEmpty || kind.label.lowercased().contains(needle) || kind.sub.lowercased().contains(needle)
		}
		let own = TriggerKind.allCases.filter { $0.connection == nil && matches($0) }
		let integrations = TriggerKind.allCases.filter { kind in
			kind.connection.map(connected.contains) ?? false && matches(kind)
		}
		DialogForm(title: "Add a trigger", gap: 20) {
			SearchField(placeholder: "Search triggers", text: $query)
			if !own.isEmpty {
				SettingsGroup(label: "Built in") {
					DividedRows(data: own) { kind in
						row(kind)
					}
				}
			}
			SettingsGroup(label: "From this pod's connections") {
				ForEach(integrations) { kind in
					row(kind)
					SettingsDivider()
				}
				Button { openedSettings = pod } label: {
					SettingsRow(
						label: !integrations.isEmpty
							? "Connect another app"
							: needle.isEmpty ? "No connections with triggers yet" : "No connection matches “\(typed)”",
						sub: !integrations.isEmpty ? "In \(pod.name)'s settings" : "Connect an app in \(pod.name)'s settings",
						trailing: { Icon(.arrowUpRight, size: 15).foregroundStyle(Palette.subtleForeground) }
					)
				}
				.buttonStyle(SettingsRowPressStyle())
			}
			if let connectionsFailure { FormAlert(text: connectionsFailure) }
		}
		.task {
			do {
				connected = Set(try await store.connections(in: pod.id).map(\.kind))
			} catch {
				connectionsFailure = error.localizedDescription
			}
		}
		.sheet(item: $openedSettings) { pod in
			PageStack { RouteDestination(route: .podSettings(pod)) }
		}
	}

	private func row(_ kind: TriggerKind) -> some View {
		Button { choose(kind) } label: {
			SettingsRow(label: kind.label, sub: kind.sub, chevron: true, leading: { TriggerKindMark(kind: kind) })
		}
		.buttonStyle(SettingsRowPressStyle())
	}
}

// MARK: Schedule

/// A schedule's groups: how often it repeats and every how many, on which
/// days, then at which times, with `note` under the last. A schedule written
/// as cron shows as written until a repeat is picked in its place.
struct ScheduleGroups: View {
	let reading: ScheduleReading
	let note: String
	let change: (CalendarSchedule) -> Void

	var body: some View {
		let schedule = reading.schedule
		SettingsGroup(note: schedule == nil ? note : nil) {
			SettingsChoiceRow(
				label: "Repeat",
				options: ScheduleWords.repeatOptions,
				value: schedule?.repeatKind
			) { change(ScheduleWords.withRepeat(reading, $0)) }
			if case let .written(expression, label) = reading {
				SettingsDivider()
				VStack(alignment: .leading, spacing: 4) {
					Text(label).font(Typeface.rubik(14.5)).foregroundStyle(Palette.foreground)
					Text(expression).font(Typeface.mono(13)).foregroundStyle(Palette.mutedForeground)
					Text("Pick a repeat to replace it.").font(Typeface.rubik(12.5)).foregroundStyle(Palette.subtleForeground)
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				.padding(.horizontal, 16)
				.padding(.vertical, 12)
			}
			if let schedule { RepeatRows(schedule: schedule, change: change) }
		}
		if let schedule {
			SettingsGroup(note: note) {
				TimesRow(times: schedule.times) { times in
					var changed = schedule
					changed.times = times
					change(changed)
				}
			}
		}
	}
}

/// Every how many days, weeks or months, and for a weekly or monthly schedule, on which days.
private struct RepeatRows: View {
	let schedule: CalendarSchedule
	let change: (CalendarSchedule) -> Void

	/// The days of the month a schedule can pick: the 1st to the 28th, then the last day.
	private static let lastNumberedDay = 28

	var body: some View {
		let max = ScheduleWords.maxEvery(schedule.repeatKind)
		SettingsDivider()
		StepperRow(
			label: "Every",
			value: ScheduleWords.formatEvery(schedule),
			lessLabel: "Closer together",
			moreLabel: "Further apart",
			onLess: schedule.every > 1 ? { changeEvery(schedule.every - 1) } : nil,
			onMore: schedule.every < max ? { changeEvery(schedule.every + 1) } : nil
		)
		if schedule.repeatKind == .weekly {
			SettingsDivider()
			VStack(alignment: .leading, spacing: 8) {
				Text("Days").font(Typeface.rubik(16)).foregroundStyle(Palette.foreground)
				HStack(spacing: 0) {
					ForEach(Array(ScheduleWords.days.enumerated()), id: \.offset) { index, day in
						if index > 0 { Spacer(minLength: 6) }
						let selected = schedule.days.contains(day.value)
						Button {
							var changed = schedule
							changed.days = selected ? schedule.days.filter { $0 != day.value } : schedule.days + [day.value]
							change(changed)
						} label: {
							Text(day.letter)
								.font(Typeface.rubik(13, .medium))
								.foregroundStyle(selected ? Palette.primaryForeground : Palette.softForeground)
								.frame(width: 32, height: 32)
								.background(selected ? Palette.primary : Palette.chip, in: Circle())
						}
						.buttonStyle(.plain)
						.accessibilityLabel(day.long)
						.accessibilityAddTraits(selected ? .isSelected : [])
					}
				}
			}
			.padding(.horizontal, 16)
			.padding(.vertical, 10)
		}
		if schedule.repeatKind == .monthly {
			SettingsDivider()
			StepperRow(
				label: "On the",
				value: ScheduleWords.formatDayOfMonth(schedule.dayOfMonth),
				lessLabel: "A day earlier",
				moreLabel: "A day later",
				onLess: { stepDay(-1) },
				onMore: { stepDay(1) }
			)
		}
	}

	/// How often counts from today, so a change of pace starts now.
	private func changeEvery(_ every: Int) {
		var changed = schedule
		changed.every = every
		changed.startsOn = ScheduleWords.today()
		change(changed)
	}

	/// The 1st to the 28th, then the last day, round again either way.
	private func stepDay(_ step: Int) {
		let count = Self.lastNumberedDay + 1
		let position: Int = if case let .day(number) = schedule.dayOfMonth { number } else { count }
		let next = ((position - 1 + step + count) % count) + 1
		var changed = schedule
		changed.dayOfMonth = next == count ? .last : .day(next)
		change(changed)
	}
}

/// The times a schedule runs at, each a chip picked from the half hours, with
/// an × to remove it while another is left, and + Add for one more.
private struct TimesRow: View {
	let times: [Int]
	let change: ([Int]) -> Void

	private static let pickable = Array(stride(from: 0, to: 24 * 60, by: ScheduleWords.timeStepMinutes))

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			Text("Times").font(Typeface.rubik(16)).foregroundStyle(Palette.foreground)
			FlowLayout(spacing: 8) {
				ForEach(Array(times.enumerated()), id: \.offset) { index, time in
					let others = times.enumerated().filter { $0.offset != index }.map(\.element)
					let options = Self.pickable.contains(time) ? Self.pickable : (Self.pickable + [time]).sorted()
					HStack(spacing: 0) {
						Menu {
							ForEach(options, id: \.self) { option in
								Button {
									change(times.enumerated().map { $0.offset == index ? option : $0.element })
								} label: {
									if option == time { Label(ScheduleWords.formatTime(option), systemImage: "checkmark") } else { Text(ScheduleWords.formatTime(option)) }
								}
								.disabled(others.contains(option))
							}
						} label: {
							Text(ScheduleWords.formatTime(time))
								.font(Typeface.rubik(14, .semibold))
								.monospacedDigit()
								.foregroundStyle(Palette.foreground)
								.padding(.leading, 12)
								.padding(.trailing, 4)
								.frame(height: 32)
						}
						.accessibilityLabel("Time \(index + 1)")
						if times.count > 1 {
							Button { change(others) } label: {
								Icon(.x, size: 14).frame(width: 24, height: 24).contentShape(Circle())
							}
							.buttonStyle(IconPressStyle())
							.accessibilityLabel("Remove \(ScheduleWords.formatTime(time))")
						} else {
							Spacer().frame(width: 8)
						}
					}
					.background(Palette.chip, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
				}
				if times.count < Limits.maxRoutineScheduleTimes {
					Button("+ Add") { change(times + [ScheduleWords.nextTime(times)]) }
						.font(Typeface.rubik(14, .medium))
						.foregroundStyle(Palette.primaryForeground)
						.padding(.horizontal, 12)
						.frame(height: 32)
						.background(Palette.primary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
						.accessibilityLabel("Add a time")
				}
			}
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 10)
	}
}

// MARK: Webhook

/// A webhook trigger as written, before it is saved.
struct WebhookDraft: Hashable {
	var auth = WebhookAuthChoice.default
	/// Blank for none, so the address alone runs it.
	var secret = ""

	static let secretTooShortNote = "A secret needs at least \(Limits.minWebhookSecretCharacters) characters."
	static let noSecretNote = "With no secret, anyone who has the address can run it. Add one so only the sender can."

	/// Whether the secret can be saved: a source's, however long; one made up, long enough; or none.
	var secretReady: Bool {
		let trimmed = secret.trimmingCharacters(in: .whitespaces)
		return trimmed.isEmpty || auth.isSource || trimmed.count >= Limits.minWebhookSecretCharacters
	}
}

extension WebhookAuthChoice {
	/// What each generic kind asks for when it is chosen.
	static func genericDefault(_ kind: String) -> WebhookAuthChoice {
		switch kind {
		case "api_key": .apiKey(header: "X-API-Key")
		case "bearer": .bearer
		case "basic": .basic(username: "sugabots")
		default: .default
		}
	}

	/// "generic" for any sender, else the source.
	var source: String { isSource ? kind : "generic" }

	/// What the secret is called: every source's is a signing secret.
	var secretLabel: String {
		isSource ? "Signing secret" : Self.secretLabels[kind] ?? "Secret"
	}

	/// How the secret looks: a source's format, or the prefix of a kind's own secrets.
	var secretPlaceholder: String? {
		if isSource { return Self.sourceSecretPlaceholders[kind] }
		guard let prefix = Self.secretPrefixes[kind], !prefix.isEmpty else { return nil }
		return "\(prefix)…"
	}

	/// What a caller must do to be let in; nil for a source from a newer server than this app knows.
	var note: String? {
		switch self {
		case let .source(source):
			Self.sourceNotes[source]
		case let .hmac(header, algorithm, encoding):
			"Sign the raw request body with the secret using HMAC \(Self.label(Self.algorithmOptions, algorithm)), and send the digest in \(header), written in \(Self.label(Self.encodingOptions, encoding).lowercased())."
		case let .apiKey(header): "Send the key in the \(header) header."
		case .bearer: "Send the token in the Authorization header as Bearer."
		case .basic: "Send the username and password with HTTP Basic auth."
		}
	}

	static func label(_ options: [(value: String, label: String)], _ value: String) -> String {
		options.first { $0.value == value }?.label ?? value
	}
}

/// The webhook groups of a routine being made: where it comes from, then its auth and secret, under `note`.
struct NewWebhookGroups: View {
	@Binding var draft: WebhookDraft
	let note: String?

	var body: some View {
		SettingsGroup {
			SettingsControlRow(label: "Address") {
				Text("Made when you create it").font(Typeface.rubik(14.5)).foregroundStyle(Palette.mutedForeground)
				Spacer(minLength: 0)
			}
			SettingsDivider()
			WebhookSourceRow(auth: $draft.auth)
		}
		SettingsGroup(note: note) {
			WebhookAuthRows(auth: $draft.auth)
			SettingsDivider()
			SecretFieldRow(label: draft.auth.secretLabel, placeholder: draft.auth.secretPlaceholder, value: $draft.secret)
		}
	}
}

/// Where the webhook comes from: a known source, with its logo, or Generic for any other sender.
struct WebhookSourceRow: View {
	@Binding var auth: WebhookAuthChoice

	var body: some View {
		MenuRow(
			label: "Source",
			options: WebhookAuthChoice.sourceOptions,
			value: auth.source,
			mark: { source in
				if source == "generic" {
					Icon(.webhook, size: 14, strokeWidth: 2.2)
						.foregroundStyle(Palette.softForeground)
						.frame(width: 24, height: 24)
						.background(Palette.chip, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
				} else {
					ConnectionMark(presetId: source, name: WebhookAuthChoice.sourceLabels[source] ?? source, size: .md)
				}
			}
		) { source in
			auth = source == "generic" ? .default : .source(source)
		}
	}
}

/// For a generic webhook, the auth to ask callers for and what it needs.
struct WebhookAuthRows: View {
	@Binding var auth: WebhookAuthChoice

	var body: some View {
		if !auth.isSource {
			SettingsDivider()
			MenuRow(label: "Auth", options: WebhookAuthChoice.authOptions, value: auth.kind) { auth = .genericDefault($0) }
		}
		switch auth {
		case let .hmac(header, algorithm, encoding):
			SettingsDivider()
			CommittedFieldRow(label: "Header", value: header, placeholder: "X-Signature") { auth = .hmac(header: $0, algorithm: algorithm, encoding: encoding) }
			SettingsDivider()
			MenuRow(label: "Algorithm", options: WebhookAuthChoice.algorithmOptions, value: algorithm) { auth = .hmac(header: header, algorithm: $0, encoding: encoding) }
			SettingsDivider()
			MenuRow(label: "Encoding", options: WebhookAuthChoice.encodingOptions, value: encoding) { auth = .hmac(header: header, algorithm: algorithm, encoding: $0) }
		case let .apiKey(header):
			SettingsDivider()
			CommittedFieldRow(label: "Header", value: header, placeholder: "X-API-Key") { auth = .apiKey(header: $0) }
		case let .basic(username):
			SettingsDivider()
			CommittedFieldRow(label: "Username", value: username, placeholder: "sugabots") { auth = .basic(username: $0) }
		default:
			EmptyView()
		}
	}
}

/// A short field, such as a header's name, that commits trimmed when it's left; blank or unchanged puts it back.
struct CommittedFieldRow: View {
	let label: String
	let value: String
	let placeholder: String
	let commit: (String) -> Void
	@State private var draft: String?
	@FocusState private var focused: Bool

	var body: some View {
		SettingsControlRow(label: label) {
			TextField("", text: Binding(get: { draft ?? value }, set: { draft = $0 }), prompt: Text(placeholder).foregroundStyle(Palette.mutedForeground))
				.font(Typeface.mono(16))
				.foregroundStyle(Palette.foreground)
				.autocorrectionDisabled()
				.textInputAutocapitalization(.never)
				.focused($focused)
				.onSubmit(finish)
				.onChange(of: focused) { _, isFocused in if !isFocused { finish() } }
				.accessibilityLabel(label)
		}
	}

	private func finish() {
		let trimmed = (draft ?? value).trimmingCharacters(in: .whitespaces)
		draft = nil
		if !trimmed.isEmpty, trimmed != value { commit(trimmed) }
	}
}

/// A secret's field, hidden until shown, with Show and Copy once it has
/// something in it; `onCommit` runs when the field is submitted or left.
struct SecretFieldRow: View {
	let label: String
	let placeholder: String?
	@Binding var value: String
	var error: String?
	var onCommit: (() -> Void)?
	@State private var shown = false
	@FocusState private var focused: Bool
	@Environment(Toaster.self) private var toaster

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			HStack(spacing: 12) {
				Text(label).font(Typeface.rubik(16)).foregroundStyle(Palette.foreground).frame(minWidth: SettingsRowMetrics.labelWidth, alignment: .leading).fixedSize()
				Group {
					if shown {
						TextField("", text: $value, prompt: prompt)
					} else {
						SecureField("", text: $value, prompt: prompt)
					}
				}
				.font(Typeface.mono(16))
				.foregroundStyle(Palette.foreground)
				.autocorrectionDisabled()
				.textInputAutocapitalization(.never)
				.focused($focused)
				.onSubmit { onCommit?() }
				.onChange(of: focused) { _, isFocused in if !isFocused { onCommit?() } }
				.accessibilityLabel(label)
				if !value.isEmpty {
					Button { shown.toggle() } label: { Icon(shown ? .eyeOff : .eye, size: 15).frame(width: 30, height: 30) }
						.buttonStyle(IconPressStyle())
						.accessibilityLabel(shown ? "Hide" : "Show")
					Button {
						UIPasteboard.general.string = value.trimmingCharacters(in: .whitespaces)
						toaster.show("Copied")
					} label: { Icon(.copy, size: 15).frame(width: 30, height: 30) }
						.buttonStyle(IconPressStyle())
						.accessibilityLabel("Copy \(label.lowercased())")
				}
			}
			if let error { Text(error).font(Typeface.rubik(12.5)).foregroundStyle(Palette.destructiveText) }
		}
		.settingsRowPadding(vertical: 10, minHeight: SettingsRowMetrics.compactMinHeight)
	}

	private var prompt: Text {
		Text(placeholder ?? "").font(Typeface.rubik(14.5)).foregroundStyle(Palette.mutedForeground)
	}
}

// MARK: Repository

/// A repository trigger as written, before its repository is chosen.
struct RepositoryDraft: Hashable {
	var connectionId: String?
	var repository: String?
	var events: [RepositoryEvent] = [.pullRequestOpened]

	static let pickAnEventNote = "Pick at least one thing for it to run on."
}

/// The repository and events groups, for a routine on a bot in `pod`, from its GitHub connection's repositories.
struct RepositoryGroups: View {
	let pod: Pod
	@Binding var draft: RepositoryDraft
	@Environment(WorkspaceStore.self) private var store
	@State private var loaded: (connectionId: String?, repositories: [String])?
	@State private var failure: String?

	var body: some View {
		Group {
			if let failure {
				FormAlert(text: failure)
			} else if let loaded {
				if let connectionId = loaded.connectionId, !loaded.repositories.isEmpty {
					SettingsGroup(label: "Repository", note: "\(pod.name)'s repositories.") {
						DividedRows(data: loaded.repositories, id: \.self) { repository in
							Button {
								draft.connectionId = connectionId
								draft.repository = repository
							} label: {
								HStack {
									Text(repository).font(Typeface.mono(13.5)).foregroundStyle(Palette.foreground).frame(maxWidth: .infinity, alignment: .leading)
									if draft.connectionId == connectionId, draft.repository?.lowercased() == repository.lowercased() {
										Icon(.check, size: 16, strokeWidth: 2.4).foregroundStyle(Palette.foreground)
									}
								}
								.settingsRowPadding()
								.contentShape(Rectangle())
							}
							.buttonStyle(SettingsRowPressStyle())
						}
					}
					SettingsGroup(
						label: "Runs when",
						note: draft.events.isEmpty ? RepositoryDraft.pickAnEventNote : "What the bots' own pushes, comments and pull requests cause doesn't run it."
					) {
						DividedRows(data: RepositoryDraft.events, id: \.value) { listed in
							let event = RepositoryEvent(rawValue: listed.value)
							SwitchRow(label: listed.label, isOn: Binding(
								get: { draft.events.contains(event) },
								set: { on in
									draft.events = on
										? RepositoryDraft.events.map { RepositoryEvent(rawValue: $0.value) }.filter { $0 == event || draft.events.contains($0) }
										: draft.events.filter { $0 != event }
								}
							), fontSize: 14.5)
						}
					}
				} else {
					InfoNote(text: "\(pod.name) isn't connected to any GitHub repositories yet. Someone who manages its connections can connect GitHub in the pod's settings.")
				}
			}
		}
		.task {
			do {
				let connectionId = try await store.connections(in: pod.id).first { $0.kind == .github }?.id
				var repositories: [String] = []
				if let connectionId {
					repositories = try await store.repositories(in: pod.id, connectionId: connectionId).repositories.map(\.repository)
				}
				loaded = (connectionId, repositories)
			} catch {
				failure = error.localizedDescription
			}
		}
	}
}
