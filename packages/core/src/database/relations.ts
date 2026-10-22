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
		// The message a thread opened from a pod's chat was started with.
		origin: r.one.message({ from: r.thread.originMessageId, to: r.message.id }),
		// On a pod's chat: the threads people started from it.
		openedThreads: r.many.thread({ from: r.thread.id, to: r.thread.parentThreadId }),
		hostAgent: r.one.agent({ from: r.thread.hostAgentId, to: r.agent.id }),
		// On a conversation: every thread in it, the conversation's own included.
		conversationThreads: r.many.thread({ from: r.thread.id, to: r.thread.conversationId }),
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
		files: r.many.threadFile({ from: r.message.id, to: r.threadFile.messageId }),
		collaborations: r.many.collaboration({
			from: r.message.id,
			to: r.collaboration.parentMessageId,
		}),
		routineExecution: r.one.routineExecution({
			from: r.message.routineExecutionId,
			to: r.routineExecution.id,
		}),
		replyTo: r.one.message({ from: r.message.replyToMessageId, to: r.message.id }),
		reactions: r.many.messageReaction({ from: r.message.id, to: r.messageReaction.messageId }),
	},
	messageReaction: {
		user: r.one.user({ from: r.messageReaction.userId, to: r.user.id, optional: false }),
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
