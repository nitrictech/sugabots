import SwiftUI

/// The models to search, as the web's `ModelPicker`: Suggested first, the
/// default and those most bots think with, then each provider's under its
/// logo. Each shows what it can do, and a radio for the one chosen.
@MainActor
struct ModelPicker: View {
	let models: [WorkspaceModel]
	let value: String?
	let defaultModel: String?
	let loading: Bool
	let choose: (String) -> Void
	@Environment(WorkspaceStore.self) private var store
	@State private var search = ""

	/// How many models Suggested holds: the default, then those most bots use.
	private static let suggestedCount = 3

	var body: some View {
		let words = search.trimmingCharacters(in: .whitespaces).lowercased()
		let usersOf = { (modelId: String) in store.agents.filter { $0.model == modelId && $0.systemAgentKey == nil }.count }
		let found = models.filter { model in
			words.isEmpty || [model.displayName ?? "", model.modelId, model.providerName].contains { $0.lowercased().contains(words) }
		}
		let suggested: [WorkspaceModel] =
			words.isEmpty
			? Array(
				models.enumerated()
					.sorted { a, b in
						let aDefault = a.element.modelId == defaultModel, bDefault = b.element.modelId == defaultModel
						if aDefault != bDefault { return aDefault }
						let (aUsers, bUsers) = (usersOf(a.element.modelId), usersOf(b.element.modelId))
						return aUsers != bUsers ? aUsers > bUsers : a.offset < b.offset
					}
					.map(\.element)
					.enumerated()
					.filter { $0.offset == 0 || usersOf($0.element.modelId) > 0 }
					.map(\.element)
					.prefix(Self.suggestedCount)
			)
			: []
		let rest = found.filter { !suggested.contains($0) }
		let providers = rest.map(\.providerName).reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
		VStack(spacing: 0) {
			VStack(alignment: .leading, spacing: 16) {
				Text("Model").font(Typeface.rubik(15, .semibold)).foregroundStyle(Palette.foreground).frame(height: 22)
				HStack(spacing: 8) {
					Icon(.search, size: 15, strokeWidth: 1.75).foregroundStyle(Palette.subtleForeground)
					TextField("", text: $search, prompt: Text("Search \(models.count) \(models.count == 1 ? "model" : "models")").foregroundStyle(Palette.subtleForeground))
						.font(Typeface.rubik(16))
						.foregroundStyle(Palette.foreground)
						.autocorrectionDisabled()
						.textInputAutocapitalization(.never)
						.onSubmit { if let first = found.first { choose(first.modelId) } }
						.accessibilityLabel("Search models")
				}
				.padding(.horizontal, 12)
				.frame(height: 40)
				.overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Palette.borderStrong))
			}
			.padding(.horizontal, 20)
			.padding(.top, 20)
			.padding(.bottom, 12)
			ScrollView {
				LazyVStack(alignment: .leading, spacing: 0) {
					if found.isEmpty {
						Text(
							loading ? "Loading models…"
								: models.isEmpty ? "No models are switched on yet. Connect one in Settings under Models."
								: "No models match."
						)
						.font(Typeface.rubik(13))
						.foregroundStyle(Palette.mutedForeground)
						.padding(.horizontal, 8)
						.padding(.vertical, 12)
					}
					if !suggested.isEmpty {
						group("Suggested", mark: AnyView(Icon(.star, size: 14, strokeWidth: 1.75)), models: suggested)
					}
					ForEach(providers, id: \.self) { provider in
						let inGroup = rest.filter { $0.providerName == provider }
						group(provider, mark: AnyView(ProviderMark(model: inGroup[0])), models: inGroup)
					}
				}
				.padding(.horizontal, 12)
				.padding(.bottom, 16)
			}
		}
	}

	private func group(_ label: String, mark: AnyView, models: [WorkspaceModel]) -> some View {
		VStack(alignment: .leading, spacing: 0) {
			HStack(spacing: 8) {
				mark
				Text(label)
			}
			.font(Typeface.rubik(12.5, .medium))
			.foregroundStyle(Palette.mutedForeground)
			.padding(.horizontal, 8)
			.padding(.top, 8)
			.padding(.bottom, 6)
			.accessibilityAddTraits(.isHeader)
			ForEach(models) { model in
				ModelRow(model: model, chosen: model.modelId == value, isDefault: model.modelId == defaultModel) { choose(model.modelId) }
			}
		}
		.padding(.bottom, 8)
	}
}

/// A model to choose: its name, Default on the workspace's default, under it what it can do, and a radio.
private struct ModelRow: View {
	let model: WorkspaceModel
	let chosen: Bool
	let isDefault: Bool
	let choose: () -> Void

	/// What a model can do, as the icons on its row draw it, with the words VoiceOver says.
	private static let capabilities: [(capability: String, icon: Lucide, label: String)] = [
		("tools", .wrench, "uses tools"),
		("vision", .eye, "reads images"),
		("reasoning", .brain, "reasons"),
		("images", .image, "makes images"),
		("audio", .audioLines, "hears and speaks"),
	]

	var body: some View {
		let shown = model.capabilities.compactMap { capability in Self.capabilities.first { $0.capability == capability.rawValue } }
		Button(action: choose) {
			HStack(spacing: 12) {
				VStack(alignment: .leading, spacing: 4) {
					HStack(spacing: 8) {
						Text(model.name).font(Typeface.rubik(14, .medium)).foregroundStyle(Palette.foreground).lineLimit(1)
						if isDefault {
							Text("Default")
								.font(Typeface.rubik(10.5, .medium))
								.foregroundStyle(Palette.mutedForeground)
								.padding(.horizontal, 6)
								.frame(height: 16)
								.overlay(RoundedRectangle(cornerRadius: 4, style: .continuous).strokeBorder(Palette.borderStrong))
						}
					}
					if !shown.isEmpty {
						HStack(spacing: 6) {
							ForEach(shown, id: \.capability) { Icon($0.icon, size: 13, strokeWidth: 1.75) }
						}
						.foregroundStyle(Palette.subtleForeground)
					}
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				Circle()
					.strokeBorder(chosen ? Palette.foreground : Palette.disabledForeground, lineWidth: 1.5)
					.frame(width: 18, height: 18)
					.overlay { if chosen { Circle().fill(Palette.foreground).frame(width: 8, height: 8) } }
			}
			.padding(.horizontal, 8)
			.padding(.vertical, 8)
			.frame(minHeight: 56)
			.background(chosen ? Palette.chip : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
			.contentShape(Rectangle())
		}
		.buttonStyle(PressableRowStyle(pressed: Palette.chip, cornerRadius: 8))
		.accessibilityLabel(([model.name] + (isDefault ? ["Default"] : []) + shown.map(\.label)).joined(separator: ", "))
		.accessibilityAddTraits(chosen ? .isSelected : [])
	}
}

/// A model's provider, as its logo, or its initial when it has none.
struct ProviderMark: View {
	let model: WorkspaceModel

	var body: some View {
		if let preset = model.providerPreset?.rawValue, let logo = ProviderLogos.assets[preset] {
			Image(logo.image).resizable().scaledToFit().frame(width: 14, height: 14).scaleEffect(logo.scale)
		} else {
			Text(model.providerName.trimmingCharacters(in: .whitespaces).prefix(1).uppercased())
				.font(Typeface.rubik(9))
				.frame(width: 14, height: 14)
				.background(Palette.chipStrong, in: RoundedRectangle(cornerRadius: 3, style: .continuous))
		}
	}
}
