import Foundation

/// Routines in full: listing, making, and changing their triggers.
extension WorkspaceStore {
	/// Every routine the person reaches in the workspace, in full.
	func workspaceRoutines() async throws -> [WorkspaceRoutine] {
		try await client.routines.listInWorkspace(workspace: workspace.id).items
	}

	/// A bot's routines, in full.
	func routines(of agentId: String) async throws -> [Routine] {
		try await client.routines.list(agentId: agentId)
	}

	/// Changes some of a routine's fields; those left nil stay as they are.
	func updateRoutine(
		_ routineId: String,
		agentId: String,
		name: String? = nil,
		instructions: String? = nil,
		state: RoutineState? = nil,
		results: RoutineResults? = nil,
		chatId: String?? = nil
	) async throws -> Routine {
		let result = try await client.routines.update(
			agentId: agentId, routineId: routineId, name: name, instructions: instructions, state: state, results: results, chatId: chatId
		)
		await refreshAfterRoutineChange(agentId: agentId)
		return result.routine
	}

	/// Runs a routine now; its result posts in its thread.
	func runRoutine(_ routineId: String, agentId: String) async throws {
		_ = try await client.routines.run(agentId: agentId, routineId: routineId, requestId: UUID().uuidString.lowercased())
		await refreshAfterRoutineChange(agentId: agentId)
	}

	/// Deletes a routine. Runs already in its bot's chat stay there.
	func deleteRoutine(_ routineId: String, agentId: String) async throws {
		try await client.routines.remove(agentId: agentId, routineId: routineId)
		await refreshAfterRoutineChange(agentId: agentId)
	}

	/// Makes a routine, then refreshes what it may show in: the pod's list and the attention counts.
	func createRoutine(agentId: String, routine: NewRoutine) async throws -> RoutineWriteResult {
		let result = try await client.routines.create(
			agentId: agentId,
			name: routine.name,
			instructions: routine.instructions,
			state: routine.state,
			results: routine.results,
			chatId: routine.chatId,
			triggers: routine.triggers
		)
		await refreshAfterRoutineChange(agentId: agentId)
		return result
	}

	/// The pod's list and the attention counts, which a routine's change may move.
	private func refreshAfterRoutineChange(agentId: String) async {
		guard let podId = agent(id: agentId)?.podId, let pod = pod(id: podId) else { return }
		await refreshChatList(pod)
		await refreshAttention()
	}

	/// The address that runs a webhook trigger.
	func webhookAddress(of triggerId: String) -> String {
		client.baseURL.appending(path: "hooks/triggers/\(triggerId)").absoluteString
	}

	/// A routine in full, by its bot and id.
	func routine(_ routineId: String, agentId: String) async throws -> Routine {
		try await client.routines.get(agentId: agentId, routineId: routineId)
	}

	/// The routine's latest run, if it has run.
	func latestRun(of routineId: String, agentId: String) async throws -> RoutineExecution? {
		try await client.routines.executions(agentId: agentId, routineId: routineId, limit: "1").items.first
	}

	/// Adds a trigger to a routine.
	func addTrigger(_ trigger: TriggerInput, to routineId: String, agentId: String) async throws -> RoutineWriteResult {
		try await client.routines.addTrigger(agentId: agentId, routineId: routineId, body: trigger.apiValue)
	}

	/// Replaces one of a routine's triggers.
	func updateTrigger(_ triggerId: String, with trigger: TriggerInput, routineId: String, agentId: String) async throws -> RoutineWriteResult {
		try await client.routines.updateTrigger(agentId: agentId, routineId: routineId, triggerId: triggerId, body: trigger.apiValue)
	}

	/// Removes one of a routine's triggers.
	func removeTrigger(_ triggerId: String, routineId: String, agentId: String) async throws -> Routine {
		try await client.routines.removeTrigger(agentId: agentId, routineId: routineId, triggerId: triggerId)
	}

	/// A webhook trigger's secret, for somebody who manages the routine.
	func webhookSecret(of triggerId: String, routineId: String, agentId: String) async throws -> RoutineCurrentSecret {
		try await client.routines.getSecret(agentId: agentId, routineId: routineId, triggerId: triggerId)
	}

	/// Replaces a webhook trigger's secret: with `secret`, a new one when nil, or none when `none`.
	func replaceWebhookSecret(of triggerId: String, routineId: String, agentId: String, with secret: String?, none: Bool = false) async throws -> String? {
		let replacement: String?? = none ? .some(nil) : secret.map { .some($0) }
		return try await client.routines.rotateSecret(agentId: agentId, routineId: routineId, triggerId: triggerId, secret: replacement).secret
	}

	/// The repositories a pod's GitHub connection reaches.
	func repositories(in podId: String, connectionId: String) async throws -> ConnectionRepositories {
		try await client.gitHubConnections.repositories(podId: podId, connectionId: connectionId)
	}

	/// A routine's thread, by the routine's id, opened the first time somebody looks at it.
	func routineFeed(routineId: String, in pod: Pod) async throws -> RoutineFeed {
		if let listed = chatLists[pod.id]?.routines.first(where: { $0.routine.id == routineId }) {
			return try await routineFeed(for: listed)
		}
		return try await client.chats.openRoutineFeed(workspace: workspace.id, routineId: routineId)
	}
}
