import SwiftUI

/// Making a bot, over the whole screen, as the web's `NewAgentDialog` on a
/// phone: Close, New bot and Create across the top on a tint of the bot's
/// colour, the bot as it will be, which opens its look, and its name; then the
/// models it can think with, the suggested first, then each provider's.
/// Made without a prompt, it starts by asking its creator what it's for.
@MainActor
struct NewBotScreen: View {
	let pod: Pod
	let created: (Agent) -> Void
	@Environment(WorkspaceStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	@State private var name = ""
	@State private var look = NewBotScreen.randomLook()
	@State private var customising = false
	@State private var part = LookPart.shape
	@State private var chosenModel: String?
	@State private var modelsFailed = false
	@State private var creating = false
	@State private var failure: String?
	@FocusState private var naming: Bool


	var body: some View {
		let models = store.enabledModels
		let offered = models?.models ?? []
		// The default model may be missing when its provider is disabled; fall back to the first offered.
		let model = chosenModel ?? offered.first { $0.modelId == models?.defaultModel }?.modelId ?? offered.first?.modelId
		let trimmed = name.trimmingCharacters(in: .whitespaces)
		let canCreate = !trimmed.isEmpty && model != nil && !creating
		// A tint of the bot's colour, so the bot is shown in its own light.
		let stage = BotLooks.palette(for: look.color).face.opacity(0.09)
		VStack(spacing: 0) {
			VStack(spacing: 0) {
				ScreenHeader(title: customising ? "Look" : "New bot") {
					if customising {
						GlassRoundButton(icon: .chevronLeft, label: "Back") { customising = false }
					} else {
						GlassRoundButton(icon: .x, label: "Close", iconSize: 20) { dismiss() }
					}
				} trailing: {
					if !customising {
						Button("Create") { create(model: model) }
							.buttonStyle(WebButtonStyle(size: .pill))
							.disabled(!canCreate)
					}
				}
				.padding(.bottom, 8)
				VStack(spacing: 16) {
					Button { customising = true } label: {
						BotFace(look: look, size: 112)
							.scaleEffect(naming || customising ? 0.5 : 1, anchor: .top)
							.frame(height: naming || customising ? 56 : 112, alignment: .top)
							.overlay(alignment: .bottomTrailing) {
								if !customising, !naming {
									Icon(.pencil, size: 14)
										.foregroundStyle(Palette.foreground)
										.frame(width: 32, height: 32)
										.glass(in: Circle())
										.offset(x: 4, y: 4)
								}
							}
							.animation(.easeOut(duration: 0.3), value: naming || customising)
					}
					.buttonStyle(.plain)
					.disabled(customising)
					.accessibilityLabel("Change the look")
					if !customising {
						TextField("", text: $name.limited(to: Limits.agentNameMaxLength), prompt: Text("Name your bot").foregroundStyle(Palette.subtleForeground))
							.font(Typeface.rubik(16))
							.foregroundStyle(Palette.foreground)
							.autocorrectionDisabled()
							.focused($naming)
							.padding(.horizontal, 16)
							.frame(height: 48)
							.background(Palette.panel, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
							.overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(naming ? Palette.primaryTintBorder : Palette.borderStrong))
							.accessibilityLabel("Name")
						if let failure { FormAlert(text: failure) }
						if modelsFailed { FormAlert(text: "Models could not be loaded. Close this and try again.") }
					}
				}
				.padding(.horizontal, 16)
				.padding(.top, 8)
				.padding(.bottom, 20)
			}
			.background(stage.background(Palette.list).ignoresSafeArea(edges: .top))
			.animation(.easeOut(duration: 0.2), value: look.color)
			Rectangle().fill(Palette.border).frame(height: 1)
			Group {
				if customising {
					LookStep(part: $part, look: $look)
				} else {
					ModelPicker(models: offered, value: model, defaultModel: models?.defaultModel, loading: models == nil && !modelsFailed) { chosenModel = $0 }
				}
			}
			.frame(maxWidth: .infinity, maxHeight: .infinity)
			.background(Palette.panel.ignoresSafeArea(edges: .bottom))
		}
		.background(Palette.panel.ignoresSafeArea())
		.task {
			do {
				try await store.refreshModels()
				modelsFailed = false
			} catch {
				// The models last loaded, if any, are still offered.
				modelsFailed = store.enabledModels == nil
			}
		}
	}

	private func create(model: String?) {
		let trimmed = name.trimmingCharacters(in: .whitespaces)
		guard !trimmed.isEmpty, let model else { return }
		creating = true
		failure = nil
		Task {
			do {
				created(try await store.createBot(in: pod, name: trimmed, look: look, model: model))
			} catch let failure as APIFailure where failure.status == 409 {
				self.failure = "A bot with that name already exists. Try another name."
			} catch let failure as APIFailure where failure.status == 403 {
				self.failure = "Only a workspace admin can create a bot."
			} catch {
				failure = error.localizedDescription
			}
			creating = false
		}
	}

	/// A look to start from: any colour, head and eyes.
	static func randomLook() -> BotLook {
		BotLook(color: AgentColor.known.randomElement()!, face: AgentFace.known.randomElement()!, shape: AgentShape.known.randomElement()!)
	}
}
