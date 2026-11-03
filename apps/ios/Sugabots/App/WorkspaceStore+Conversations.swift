import Foundation

extension WorkspaceStore {
	/// The name a bot's model goes by, as `useModelName`: its display name, else its id; nil with none chosen.
	func modelName(_ model: String?) -> String? {
		guard let model else { return nil }
		return enabledModels?.models.first { $0.modelId == model }?.displayName ?? model
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
