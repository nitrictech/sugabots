import SwiftUI

/// Usage, as the web's `UsageSettings`: the month's spend with a bar for each
/// day and a stepper between months, then a breakdown by bot, model or pod.
/// Stepping keeps the last month shown, dimmed, until the next arrives.
@MainActor
struct UsageSettingsScreen: View {
	@Environment(WorkspaceStore.self) private var store
	@State private var usage: WorkspaceUsage?
	/// The month shown, once the workspace's clock says which is this one.
	@State private var month: YearMonth?
	@State private var thisMonth: YearMonth?
	@State private var timeZone = TimeZone.gmt
	@State private var stale = false
	@State private var failure: String?

	var body: some View {
		SettingsPage(title: "Usage", description: "What bots have cost so far this month.") {
			if let usage, let month, let thisMonth {
				SpendSummary(usage: usage, today: Self.day(.now, in: timeZone), stale: stale, month: month, latest: thisMonth) { self.month = month.shifted(by: $0) }
					.padding(.top, -8)
				if let failure { FormAlert(text: failure) }
				Breakdown(usage: usage, stale: stale)
			} else if let failure {
				FormAlert(text: failure)
			} else {
				Color.clear
					.frame(height: 228)
					.settingsCard()
			}
		}
		.task { await start() }
		.task(id: month) {
			guard let month else { return }
			await load(month)
		}
	}

	/// Finds which month is this one on the workspace's clock, and shows it.
	private func start() async {
		if let record = try? await store.workspaceRecord(), let zone = TimeZone(identifier: record.timeZone) { timeZone = zone }
		let current = YearMonth.containing(.now, in: timeZone)
		thisMonth = current
		month = current
	}

	/// Loads `month`'s usage; one stepped away from before it arrives is dropped.
	private func load(_ month: YearMonth) async {
		stale = usage != nil
		do {
			let loaded = try await store.client.usage.month(workspace: store.workspace.id, month: month.text)
			guard !Task.isCancelled else { return }
			usage = loaded
			failure = nil
			stale = false
		} catch {
			guard !Task.isCancelled else { return }
			// What was shown stays, dimmed, under what failed.
			failure = error.localizedDescription
		}
	}

	/// The date in `zone` as `YYYY-MM-DD`.
	static func day(_ date: Date, in zone: TimeZone) -> String {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = zone
		let parts = calendar.dateComponents([.year, .month, .day], from: date)
		return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
	}
}

/// How usage writes amounts, months and days, as `lib/usage.ts`.
private enum UsageFormat {
	private static let dollars: NumberFormatter = {
		let formatter = NumberFormatter()
		formatter.numberStyle = .currency
		formatter.currencyCode = "USD"
		formatter.locale = Locale(identifier: "en_US")
		return formatter
	}()

	/// As `formatUsd`: under half a cent is `<$0.01`.
	static func usd(_ usd: Double) -> String {
		if usd > 0, usd < 0.005 { return "<\(dollars.string(from: 0.01) ?? "$0.01")" }
		return dollars.string(from: NSNumber(value: usd)) ?? "$\(usd)"
	}

	private static func first(of month: YearMonth) -> Date {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = .gmt
		return calendar.date(from: DateComponents(year: month.year, month: month.month, day: 1)) ?? .now
	}

	private static func monthName(_ month: YearMonth, _ format: Date.FormatStyle.Symbol.Month) -> String {
		first(of: month).formatted(Date.FormatStyle(timeZone: .gmt).month(format))
	}

	/// As `monthLabel`: `Oct 2026`.
	static func month(_ month: YearMonth) -> String { "\(monthName(month, .abbreviated)) \(month.year)" }
	/// As `longMonthLabel`: `October 2026`, or as the API wrote it if it names no month.
	static func longMonth(_ text: String) -> String {
		guard let month = YearMonth(text) else { return text }
		return "\(monthName(month, .wide)) \(month.year)"
	}
	/// As `dayLabel`: `30 Oct`, for a `YYYY-MM-DD` date.
	static func day(_ date: String) -> String {
		guard let month = YearMonth(String(date.prefix(7))) else { return date }
		return "\(Int(date.dropFirst(8).prefix(2)) ?? 0) \(monthName(month, .abbreviated))"
	}
}

/// The month's total over a bar for each day, as `SpendSummary`.
private struct SpendSummary: View {
	let usage: WorkspaceUsage
	let today: String
	let stale: Bool
	let month: YearMonth
	let latest: YearMonth
	let step: (Int) -> Void
	@State private var openDate: String?

	var body: some View {
		VStack(alignment: .leading, spacing: 20) {
			HStack(spacing: 12) {
				Text(UsageFormat.usd(usage.usd))
					.font(Typeface.rubik(32, .semibold))
					.tracking(-0.96)
					.monospacedDigit()
					.foregroundStyle(Palette.foreground)
					.opacity(stale ? 0.4 : 1)
					.frame(maxWidth: .infinity, alignment: .leading)
				HStack(spacing: 4) {
					stepButton(.chevronLeft, label: "Previous month") { step(-1) }
					Text(UsageFormat.month(month))
						.font(Typeface.rubik(13, .medium))
						.foregroundStyle(Palette.foreground)
						.frame(minWidth: 72)
					stepButton(.chevronRight, label: "Next month") { step(1) }.disabled(month >= latest)
				}
			}
			VStack(spacing: 8) {
				dailySpend
				if let first = usage.days.first, let last = usage.days.last {
					HStack {
						Text(UsageFormat.day(first.date))
						Spacer()
						Text(UsageFormat.day(last.date))
					}
					.font(Typeface.rubik(12))
					.foregroundStyle(Palette.subtleForeground)
					.accessibilityHidden(true)
				}
			}
			.opacity(stale ? 0.4 : 1)
		}
		.padding(20)
		.settingsCard()
		.animation(.easeOut(duration: 0.15), value: stale)
	}

	private func stepButton(_ icon: Lucide, label: String, action: @escaping () -> Void) -> some View {
		Button(action: action) { Icon(icon, size: 14, strokeWidth: 2).frame(width: 24, height: 24).contentShape(Circle()) }
			.buttonStyle(IconPressStyle())
			.accessibilityLabel(label)
	}

	/// A bar for each day, as tall as its share of the busiest day's; a tap shows its spend above it.
	private var dailySpend: some View {
		let busiest = usage.days.map(\.usd).max() ?? 0
		return HStack(alignment: .bottom, spacing: 0) {
			ForEach(usage.days, id: \.date) { day in
				GeometryReader { geometry in
					VStack(spacing: 0) {
						Spacer(minLength: 0)
						if day.date > today {
							RoundedRectangle(cornerRadius: 3).fill(Palette.chip).frame(height: 2)
						} else {
							RoundedRectangle(cornerRadius: 3)
								.fill(day.date == today ? Palette.usageBarToday : Palette.usageBar)
								.frame(height: max(2, busiest == 0 ? 2 : geometry.size.height * day.usd / busiest))
						}
					}
					.frame(maxWidth: .infinity)
					.background(openDate == day.date ? Palette.chip : .clear, in: RoundedRectangle(cornerRadius: 3))
				}
				.padding(.horizontal, 1.5)
				.contentShape(Rectangle())
				.onTapGesture { if day.date <= today { openDate = openDate == day.date ? nil : day.date } }
				.overlay(alignment: .top) {
					if openDate == day.date {
						VStack(spacing: 0) {
							Text(UsageFormat.usd(day.usd)).font(Typeface.rubik(12, .semibold)).monospacedDigit()
							Text(UsageFormat.day(day.date)).font(Typeface.rubik(12)).opacity(0.7)
						}
						.foregroundStyle(Palette.background)
						.padding(.horizontal, 8)
						.padding(.vertical, 4)
						.background(Palette.foreground, in: RoundedRectangle(cornerRadius: 6))
						.fixedSize()
						.offset(y: -44)
					}
				}
				.accessibilityElement()
				.accessibilityLabel("\(UsageFormat.day(day.date)): \(UsageFormat.usd(day.usd))")
			}
		}
		.frame(height: 96)
		.padding(.horizontal, -1.5)
		.accessibilityElement(children: .contain)
		.accessibilityLabel(busiest > 0 ? "Spend each day. The most was \(UsageFormat.usd(busiest))." : "Spend each day. Nothing was spent.")
	}
}

/// What the month went on, by bot, model or pod, each with a bar of its share, as `Breakdown`.
private struct Breakdown: View {
	/// What the month's spend is grouped by.
	enum Grouping: Hashable {
		case bot, model, pod
	}

	struct Line: Identifiable {
		let id: String
		let icon: AnyView
		let label: String
		let sub: String
		let color: Color
		let usd: Double
		let unpricedRequests: Int
	}

	let usage: WorkspaceUsage
	let stale: Bool
	@State private var grouping = Grouping.bot

	var body: some View {
		let lines = lines(for: grouping)
		let largest = lines.map(\.usd).max() ?? 0
		SettingsGroup(label: "Breakdown", note: Self.footnote(usage.unpricedRequests)) {
			SegmentedChoice(label: "Break the month down by", options: [(Grouping.bot, "Bot"), (.model, "Model"), (.pod, "Pod")], value: grouping) { grouping = $0 }
		} content: {
			if lines.isEmpty {
				Text("Nothing was spent in \(UsageFormat.longMonth(usage.month)).")
					.font(Typeface.rubik(13))
					.foregroundStyle(Palette.mutedForeground)
					.frame(maxWidth: .infinity)
					.padding(.vertical, 24)
			} else {
				DividedRows(data: lines) { line in
					row(line, largest: largest)
				}
				.opacity(stale ? 0.4 : 1)
			}
		}
	}

	private func row(_ line: Line, largest: Double) -> some View {
		let unknown = line.usd == 0 && line.unpricedRequests > 0
		return HStack(spacing: 12) {
			HStack(spacing: 12) {
				line.icon.accessibilityHidden(true)
				VStack(alignment: .leading, spacing: 1) {
					Text(line.label).font(Typeface.rubik(13)).foregroundStyle(Palette.foreground).lineLimit(1)
					Text(line.sub).font(Typeface.rubik(12)).foregroundStyle(Palette.subtleForeground).lineLimit(1)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			.layoutPriority(1.4)
			GeometryReader { geometry in
				Capsule().fill(Palette.chipStrong)
					.overlay(alignment: .leading) {
						Capsule().fill(line.color).frame(width: largest > 0 ? geometry.size.width * line.usd / largest : 0)
					}
			}
			.frame(minWidth: 40)
			.frame(height: 4)
			.accessibilityHidden(true)
			Text(unknown ? "—" : UsageFormat.usd(line.usd))
				.font(Typeface.rubik(13))
				.monospacedDigit()
				.foregroundStyle(Palette.foreground)
				.frame(width: 72, alignment: .trailing)
				.accessibilityLabel(unknown ? "Not priced" : UsageFormat.usd(line.usd))
		}
		.padding(.horizontal, 16)
		.padding(.vertical, 10)
		.frame(minHeight: 56)
	}

	private func lines(for grouping: Grouping) -> [Line] {
		let neutral = Palette.subtleForeground
		let systemAgents = Line(
			id: "system-agents", icon: AnyView(LetterTile(name: "System agents")), label: "System agents",
			sub: "Summaries, titles, routing, compaction, model tests", color: neutral,
			usd: usage.systemAgents.usd, unpricedRequests: usage.systemAgents.unpricedRequests
		)
		let withSystemAgents = { (lines: [Line]) in
			usage.systemAgents.usd > 0 || usage.systemAgents.unpricedRequests > 0 ? lines + [systemAgents] : lines
		}
		switch grouping {
		case .bot:
			return withSystemAgents(usage.bots.map { bot in
				let face = bot.face ?? .pill
				let shape = bot.shape ?? .circle
				let icon: AnyView = bot.color.map { color in AnyView(BotFace(look: BotLook(color: color, face: face, shape: shape), size: 24)) }
					?? AnyView(LetterTile(name: bot.name ?? "Deleted bot"))
				return Line(
					id: bot.agentId, icon: icon, label: bot.name ?? "Deleted bot", sub: bot.podName ?? "No pod",
					color: bot.color.map { BotLooks.palette(for: $0).face } ?? neutral, usd: bot.usd, unpricedRequests: bot.unpricedRequests
				)
			})
		case .model:
			let providerOf = { (model: ModelUsage) in model.preset?.rawValue ?? model.providerName ?? "removed" }
			let order = usage.models.map(providerOf).reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
			return usage.models.map { model in
				let providerName = model.providerName ?? ProviderPreset.named(model.preset?.rawValue)?.name ?? "Removed provider"
				let hue = WorkspaceUsage.providerHues[(order.firstIndex(of: providerOf(model)) ?? 0) % WorkspaceUsage.providerHues.count]
				return Line(
					id: "\(model.model):\(model.providerName ?? "")", icon: AnyView(ProviderTile(name: providerName, preset: model.preset?.rawValue)),
					label: model.displayName ?? model.model, sub: providerName,
					color: BotLooks.pods[hue]?.swatch ?? neutral, usd: model.usd, unpricedRequests: model.unpricedRequests
				)
			}
		case .pod:
			return withSystemAgents(usage.pods.map { pod in
				let label = pod.name ?? "Deleted pod"
				return Line(
					id: pod.podId, icon: AnyView(LetterTile(name: label)), label: label,
					sub: "\(pod.botCount) \(pod.botCount == 1 ? "bot" : "bots")",
					color: pod.color.flatMap { BotLooks.pods[$0.rawValue]?.swatch } ?? neutral, usd: pod.usd, unpricedRequests: pod.unpricedRequests
				)
			})
		}
	}

	/// As `footnote`.
	private static func footnote(_ unpriced: Int) -> String {
		let note = unpriced == 0 ? "" : " \(unpriced) \(unpriced == 1 ? "request" : "requests") couldn't be priced and \(unpriced == 1 ? "isn't" : "aren't") included."
		return "Estimated from each provider's published prices.\(note) Your provider bills you directly."
	}
}

/// A name's initial on a chip, as Usage's `LetterTile`.
private struct LetterTile: View {
	let name: String

	var body: some View {
		Text(name.trimmingCharacters(in: .whitespaces).prefix(1).uppercased())
			.font(Typeface.rubik(11, .semibold))
			.foregroundStyle(Palette.mutedForeground)
			.frame(width: 24, height: 24)
			.background(Palette.chip, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
	}
}
