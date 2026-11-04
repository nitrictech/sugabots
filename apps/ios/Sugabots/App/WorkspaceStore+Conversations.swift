import Foundation

extension WorkspaceStore {
	/// The name a bot's model goes by, as `useModelName`: its display name, else its id; nil with none chosen.
	func modelName(_ model: String?) -> String? {
		guard let model else { return nil }
		return enabledModels?.models.first { $0.modelId == model }?.displayName ?? model
	}

	/// One of a pod's channels as the pod's list has it, renames included; nil
	/// until the list has loaded, or once the channel is archived.
	/// What kind of conversation `conversationId` is, as a pod's chat list already
	/// says, before its own details load; nil when no loaded list has it.
	func listedKind(of conversationId: String) -> ConversationKind? {
		for list in chatLists.values {
			if let chat = list.chats.first(where: { $0.conversation.id == conversationId }) {
				return .podChat(name: chat.conversation.title)
			}
			if let channel = list.channels.first(where: { $0.conversation.id == conversationId }) {
				return .botChannel(channel.agent)
			}
			if let thread = list.threads.first(where: { $0.conversation.id == conversationId }) {
				// As the loaded thread decides: a bot's thread is one a bot hosts.
				return thread.conversation.hostAgentId.flatMap(agent(id:)).map(ConversationKind.botThread) ?? .peopleThread
			}
		}
		return nil
	}

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
