import { defineRelations } from "drizzle-orm";
import * as schema from "./schema.ts";

/**
 * The joins relational queries (`db.query`) may follow, which is how a view
 * reads a thread and everything it shows in one statement.
 */
export const relations = defineRelations(schema, (r) => ({
	thread: {
		workspace: r.one.workspace({ from: r.thread.workspaceId, to: r.workspace.id, optional: false }),
		pod: r.one.pod({ from: r.thread.podId, to: r.pod.id, optional: false }),
		messages: r.many.message({ from: r.thread.id, to: r.message.threadId }),
		participants: r.many.threadParticipant({ from: r.thread.id, to: r.threadParticipant.threadId }),
		reads: r.many.threadRead({ from: r.thread.id, to: r.threadRead.threadId }),
		routineExecution: r.one.routineExecution({
			from: r.thread.id,
			to: r.routineExecution.threadId,
		}),
		compaction: r.one.threadCompaction({ from: r.thread.id, to: r.threadCompaction.threadId }),
	},
	chat: {
		mainThread: r.one.thread({ from: r.chat.mainThreadId, to: r.thread.id, optional: false }),
		// Collaborations the chat's bot was asked to help with, from any thread.
		hostCollaborations: r.many.collaboration({
			from: r.chat.hostAgentId,
			to: r.collaboration.collaboratorAgentId,
		}),
		threads: r.many.thread({ from: r.chat.id, to: r.thread.chatId }),
		// The threads of collaborations the chat's bot was asked to help with.
		hostCollaborationThreads: r.many.thread({
			from: r.chat.hostAgentId.through(r.collaboration.collaboratorAgentId),
			to: r.thread.id.through(r.collaboration.childThreadId),
		}),
		routineExecutions: r.many.routineExecution({
			from: r.chat.id.through(r.thread.chatId),
			to: r.routineExecution.threadId.through(r.thread.id),
		}),
	},
	pod: {
		agents: r.many.agent({ from: r.pod.id, to: r.agent.podId }),
		members: r.many.user({
			from: r.pod.id.through(r.podMember.podId),
			to: r.user.id.through(r.podMember.userId),
		}),
	},
	message: {
		authorUser: r.one.user({ from: r.message.authorUserId, to: r.user.id }),
		authorAgent: r.one.agent({ from: r.message.authorAgentId, to: r.agent.id }),
		turn: r.one.turn({ from: r.message.turnId, to: r.turn.id }),
		toolCalls: r.many.toolCall({ from: r.message.id, to: r.toolCall.messageId }),
		collaborations: r.many.collaboration({
			from: r.message.id,
			to: r.collaboration.parentMessageId,
		}),
		routineExecution: r.one.routineExecution({
			from: r.message.routineExecutionId,
			to: r.routineExecution.id,
		}),
	},
	threadRead: {
		user: r.one.user({ from: r.threadRead.userId, to: r.user.id, optional: false }),
	},
	threadParticipant: {
		user: r.one.user({ from: r.threadParticipant.userId, to: r.user.id }),
		agent: r.one.agent({ from: r.threadParticipant.agentId, to: r.agent.id }),
	},
	toolCall: {
		decidedBy: r.one.user({ from: r.toolCall.decidedById, to: r.user.id }),
	},
	collaboration: {
		parentMessage: r.one.message({
			from: r.collaboration.parentMessageId,
			to: r.message.id,
			optional: false,
		}),
		collaborator: r.one.agent({
			from: r.collaboration.collaboratorAgentId,
			to: r.agent.id,
			optional: false,
		}),
	},
}));
