import Foundation

extension WorkspaceStore {
	/// The name a bot's model goes by, as `useModelName`: its display name, else its id; nil with none chosen.
	func modelName(_ model: String?) -> String? {
		guard let model else { return nil }
		return enabledModels?.models.first { $0.modelId == model }?.displayName ?? model
	}

	/// What kind of conversation `model` is: as its thread says once loaded,
	/// else as a pod's chat list already says, so the header shows the bot's
	/// face and model from the start rather than changing as it loads; else a
	/// thread between people.
	func kind(of model: ConversationModel) -> ConversationKind {
		guard let thread = model.thread else { return listedKind(of: model.threadId) ?? .peopleThread }
		if thread.type == .podChat {
			// The pod's list has a rename as soon as it's made; the thread's own title waits for its details to reload.
			return .podChat(name: podChat(model.conversationId, in: thread.podId)?.title ?? thread.title)
		}
		if thread.type == .botChannel, let agent = thread.hostAgentId.flatMap(agent(id:)) {
			return .botChannel(agent)
		}
		return threadKind(hostAgentId: thread.hostAgentId)
	}

	/// Whether a loaded chat list in some pod shows `conversationId`.
	func isListed(_ conversationId: String) -> Bool {
		listedKind(of: conversationId) != nil
	}

	/// What kind of conversation `conversationId` is, as a pod's chat list
	/// already says, before its own details load; nil when no loaded list has it.
	private func listedKind(of conversationId: String) -> ConversationKind? {
		for list in chatLists.values {
			if let chat = list.chats.first(where: { $0.conversation.id == conversationId }) {
				return .podChat(name: chat.conversation.title)
			}
			if let channel = list.channels.first(where: { $0.conversation.id == conversationId }) {
				return .botChannel(channel.agent)
			}
			if let thread = list.threads.first(where: { $0.conversation.id == conversationId }) {
				return threadKind(hostAgentId: thread.conversation.hostAgentId)
			}
		}
		return nil
	}

	/// A thread a bot hosts is that bot's; any other is between people.
	private func threadKind(hostAgentId: String?) -> ConversationKind {
		hostAgentId.flatMap(agent(id:)).map(ConversationKind.botThread) ?? .peopleThread
	}

	/// One of a pod's channels as the pod's list has it, renames included; nil
	/// until the list has loaded, or once the channel is archived.
	func podChat(_ conversationId: String, in podId: String) -> PodChat? {
		chatLists[podId]?.chats.first { $0.id == conversationId }?.conversation
	}

	/// Renames one of a pod's channels.
	func renameChat(_ conversationId: String, to name: String, in pod: Pod) async throws {
		try await client.chats.renameChat(conversationId: conversationId, name: name)
		await refreshChatList(pod)
	}

	/// Archives one of a pod's channels, which leaves its list for everyone.
	func archiveChat(_ conversationId: String, in pod: Pod) async throws {
		try await client.chats.archiveChat(conversationId: conversationId)
		await refreshChatList(pod)
	}
}
