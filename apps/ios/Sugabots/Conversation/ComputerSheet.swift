import SwiftUI

/// A bot's computer, as the web's `ComputerSheet` on a phone: a sheet with a
/// grabber over its desktop and Open full screen, or why there is none and,
/// for those who may, how to give it one.
@MainActor
struct ComputerSheet: View {
	let agent: Agent
	/// The conversation whose desktop it shows.
	var conversationId: String?
	@Environment(WorkspaceStore.self) private var store
	@State private var computersEnabled: Bool?
	@State private var turningOn = false
	@State private var failure: String?
	@State private var fullScreen = false
	@State private var settingUp = false

	var body: some View {
		// The store's copy, which turning a computer on updates.
		let agent = store.agent(id: agent.id) ?? agent
		let pod = store.pod(id: agent.podId)
		VStack(spacing: 16) {
			SheetGrabber().frame(height: 24, alignment: .top)
			switch computersEnabled {
			case nil:
				ProgressView().frame(maxWidth: .infinity, minHeight: 120)
			case false?:
				NoComputer(
					text: "Computers aren't set up yet",
					detail: store.permissions?.manageProviders == true ? "They're set up once, for the whole workspace." : "Ask a workspace admin to set them up."
				) {
					if store.permissions?.manageProviders == true {
						Button("Set up computers") { settingUp = true }.buttonStyle(WebButtonStyle(size: .phone))
					}
				}
			case true? where !agent.usesSandbox:
				let may = pod?.permissions.updateAgents ?? false
				NoComputer(
					text: "\(agent.name) doesn't have a computer",
					detail: may ? "Give it one to run commands, browse and make files." : "Ask somebody who can edit it to give it one."
				) {
					if may {
						Button("Turn on computer", action: turnOn)
							.buttonStyle(WebButtonStyle(size: .phone))
							.disabled(turningOn)
						if let failure { FormAlert(text: failure) }
					}
				}
			case true?:
				VStack(spacing: 12) {
					Button { fullScreen = true } label: {
						ZStack {
							Color.black
							VStack(spacing: 8) {
								Icon(.monitor, size: 28, strokeWidth: 1.5)
								Text("\(agent.name)'s desktop").font(Typeface.rubik(13))
							}
							.foregroundStyle(Color.white.opacity(0.6))
						}
						.aspectRatio(4 / 3, contentMode: .fit)
						.clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
						.overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.borderStrong))
					}
					.buttonStyle(.plain)
					.accessibilityLabel("Open \(agent.name)'s computer full screen")
					Button("Open full screen") { fullScreen = true }
						.buttonStyle(WebButtonStyle(variant: .secondary, size: .phone))
				}
			}
		}
		.padding(.horizontal, 16)
		.padding(.bottom, 16)
		.phoneSheet(detents: [.medium])
		.task { computersEnabled = (try? await store.computersEnabled()) ?? false }
		.fullScreenCover(isPresented: $fullScreen) {
			if let pod, let conversationId { DesktopView(pod: pod, conversationId: conversationId) }
		}
		.fullScreenCover(isPresented: $settingUp) {
			NavigationStack {
				SettingsDestination(place: .workspace(.sandboxes))
					.navigationDestination(for: Route.self) { RouteDestination(route: $0) }
			}
		}
	}

	private func turnOn() {
		turningOn = true
		failure = nil
		Task {
			do {
				try await store.giveComputer(to: agent)
			} catch {
				failure = error.localizedDescription
			}
			turningOn = false
		}
	}
}

/// Why there's no computer: a monitor, the reason, a line under it, and what to do.
private struct NoComputer<Actions: View>: View {
	let text: String
	let detail: String
	@ViewBuilder var actions: Actions

	var body: some View {
		VStack(spacing: 8) {
			Icon(.monitor, size: 28, strokeWidth: 1.5).foregroundStyle(Palette.subtleForeground)
			Text(text).font(Typeface.rubik(15, .medium)).foregroundStyle(Palette.foreground)
			Text(detail).font(Typeface.rubik(14)).lineSpacing(4).foregroundStyle(Palette.mutedForeground)
			VStack(spacing: 8) { actions }.padding(.top, 12)
		}
		.multilineTextAlignment(.center)
		.frame(maxWidth: .infinity)
		.padding(.top, 8)
	}
}
