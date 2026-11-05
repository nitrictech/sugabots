import SwiftUI

/// A conversation that is opened the first time somebody looks at it, such as
/// a pod's channel, a bot's channel or a routine's thread, shown as any
/// conversation is once it's open.
@MainActor
struct OpeningConversationScreen: View {
	/// What is opened, as the failure's title names it: "Ana's channel".
	let name: String
	/// Finds the conversation, or opens it, answering its id and title.
	let open: (WorkspaceStore) async throws -> (id: String, title: String)
	@Environment(WorkspaceStore.self) private var store
	@State private var opened: (id: String, title: String)?
	@State private var failure: String?

	var body: some View {
		Group {
			if let opened {
				ConversationScreen(threadId: opened.id, title: opened.title)
			} else if let failure {
				VStack(spacing: 0) {
					HStack { HeaderBack(); Spacer() }.pageHeaderInsets()
					EmptyState(title: "Could not open \(name)", text: failure)
				}
			} else {
				ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
			}
		}
		.task {
			do {
				opened = try await open(store)
			} catch {
				failure = error.localizedDescription
			}
		}
	}
}

extension OpeningConversationScreen {
	/// The bot's channel in the pod, titled with the bot's name.
	nonisolated static func botChannel(_ agent: Agent, in pod: Pod) -> Self {
		Self(name: "\(agent.name)'s channel") { store in
			(try await store.botChannel(in: pod, with: agent).id, agent.name)
		}
	}

	/// The pod's first channel, General.
	nonisolated static func podChat(_ pod: Pod) -> Self {
		Self(name: "this pod's channel") { store in
			let chat = try await store.openPodChat(in: pod)
			return (chat.id, chat.title)
		}
	}

	/// A routine's own thread, where its runs post.
	nonisolated static func routineFeed(_ routineId: String, in pod: Pod) -> Self {
		Self(name: "this routine") { store in
			let feed = try await store.routineFeed(routineId: routineId, in: pod)
			return (feed.id, feed.title)
		}
	}
}
