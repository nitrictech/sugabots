import SwiftUI

/// Starting a thread, as the web's `NewThread` on a phone. With a bot
/// chosen, its face asks what it should work on, over the composer. Without
/// one, the pod's bots are offered as chips to name, and sending starts a
/// thread with the first named, or with the people here. A shared pod's
/// threads start from its General; a Personal pod's from the bot's channel.
@MainActor
struct NewThreadScreen: View {
	let pod: Pod
	let agent: Agent?
	@Environment(WorkspaceStore.self) private var store
	@State private var startsFrom: ConversationModel?
	@State private var failure: String?
	@State private var draft = ""
	@State private var attachments: ComposerAttachments?
	@State private var starting = false
	@State private var failed = false
	@Environment(\.openPage) private var openPage
	/// Whether the composer has the keyboard, as `Composer.focused` says.
	@State private var composing = false

	var body: some View {
		let title = agent == nil ? "New thread in \(pod.name)" : "New thread"
		VStack(spacing: 0) {
			HStack(alignment: .top, spacing: 8) {
				HStack { HeaderBack() }.frame(maxWidth: .infinity, alignment: .leading)
				TitleBadge(title: title)
				Color.clear.frame(maxWidth: .infinity, maxHeight: 1)
			}
			.pageHeaderInsets()
			if failure != nil {
				EmptyState(title: "Could not start a thread here", text: "The API did not answer. Reload this page to try again.")
			} else if let agent {
				chosen(agent)
			} else {
				anyone(title: title)
			}
		}
		.background(Palette.background.ignoresSafeArea())
		.task(id: pod.id) { await open() }
	}

	private func chosen(_ agent: Agent) -> some View {
		VStack(spacing: 24) {
			VStack(spacing: 8) {
				BotFace(look: agent.look, size: 64).padding(.bottom, 12)
				Text("What should \(agent.name) work on?").font(Typeface.rubik(18, .semibold)).foregroundStyle(Palette.foreground)
				if let description = agent.description, !description.isEmpty {
					Text(description).font(Typeface.rubik(13)).foregroundStyle(Palette.mutedForeground)
				}
			}
			.multilineTextAlignment(.center)
			composer(placeholder: "Describe the task, paste a link or drop a file")
		}
		.padding(.horizontal, 20)
		.frame(maxHeight: .infinity)
		.padding(.bottom, 80)
	}

	private func anyone(title: String) -> some View {
		let bots = startsFrom?.details?.crew.compactMap(\.agent) ?? []
		return VStack(alignment: .leading, spacing: 0) {
			Spacer(minLength: 0)
			VStack(alignment: .leading, spacing: 16) {
				VStack(alignment: .leading, spacing: 6) {
					Text(title).font(Typeface.rubik(22, .bold)).foregroundStyle(Palette.foreground)
					Text("Name a bot to start the thread with it, or write to the people here.")
						.font(Typeface.rubik(14))
						.foregroundStyle(Palette.mutedForeground)
				}
				if !bots.isEmpty {
					FlowLayout(spacing: 8) {
						ForEach(bots, id: \.id) { bot in
							Button {
								draft = "@\(bot.handle) " + draft.drop { $0.isWhitespace }
								composing = true
							} label: {
								HStack(spacing: 8) {
									BotFace(look: bot.look, size: 20)
									Text(bot.name).font(Typeface.rubik(13.5, .medium)).foregroundStyle(Palette.foreground)
								}
								.padding(.leading, 6)
								.padding(.trailing, 12)
								.frame(height: 32)
								.overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Palette.borderStrong))
							}
							.buttonStyle(.plain)
						}
					}
				}
			}
			.padding(.horizontal, 20)
			.padding(.top, 24)
			.padding(.bottom, 16)
			VStack(alignment: .leading, spacing: 0) {
				composer(placeholder: nil)
				Text(threadWith.map { "Sending starts a thread with \($0.name)." } ?? "Sending starts a thread with the people here.")
					.font(Typeface.rubik(12.5))
					.foregroundStyle(Palette.mutedForeground)
					.padding(.horizontal, 4)
					.frame(height: 26)
			}
			.padding(.horizontal, 16)
		}
	}

	private func composer(placeholder: String?) -> some View {
		Composer(
			label: threadWith.map { "Message \($0.name)" } ?? "Message \(pod.name)",
			placeholder: placeholder,
			text: $draft,
			mentionable: (startsFrom?.mentionable ?? []).filter { $0.id != store.user.id },
			attachments: attachments,
			sending: starting,
			error: failed ? "The thread was not started. Try again." : nil,
			needsText: true,
			submit: submit,
			focused: $composing
		)
	}

	/// The bot the thread is with: the one chosen, or the first the draft names.
	private var threadWith: AgentParticipant? {
		if let agent { return AgentParticipant(agent) }
		return Mentions.firstBot(in: draft, among: startsFrom?.details?.crew ?? [])
	}

	private func open() async {
		do {
			let conversationId: String
			if pod.kind == .personal, let agent {
				conversationId = try await store.botChannel(in: pod, with: agent).id
			} else {
				conversationId = try await store.openPodChat(in: pod).id
			}
			let model = ConversationModel(threadId: conversationId, store: store, paged: false)
			startsFrom = model
			attachments = ComposerAttachments(conversationId: conversationId, client: store.client)
			await model.load()
		} catch {
			failure = error.localizedDescription
		}
	}

	private func submit() {
		guard let startsFrom, !starting else { return }
		failed = false
		starting = true
		let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
		let files = attachments?.takeForSending() ?? []
		Task {
			do {
				let started = try await startsFrom.startThread(text, with: threadWith, replyTo: nil, files: files)
				draft = ""
				openPage(.conversation(threadId: started.conversation.id, title: started.conversation.title))
			} catch {
				failed = true
			}
			starting = false
		}
	}
}

/// A channel's face over the page's title in a glass pill, heading the page.
private struct TitleBadge: View {
	let title: String

	var body: some View {
		VStack(spacing: 0) {
			ChannelFace(size: 60)
			Text(title)
				.font(Typeface.rubik(15, .semibold))
				.foregroundStyle(Palette.foreground)
				.lineLimit(1)
				.padding(.horizontal, 14)
				.frame(height: 32)
				.glass(in: Capsule())
				.frame(maxWidth: 220)
				.padding(.top, -8)
		}
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(title)
		.accessibilityAddTraits(.isHeader)
	}
}
