import { defineRelations } from "drizzle-orm";
import * as schema from "./schema.ts";

/**
 * The joins relational queries (`db.query`) may follow, which is how a view
 * reads a thread and everything it shows in one statement.
 */
export const relations = defineRelations(schema, (r) => ({
	thread: {
		pod: r.one.pod({ from: r.thread.podId, to: r.pod.id, optional: false }),
		messages: r.many.message({ from: r.thread.id, to: r.message.threadId }),
		participants: r.many.threadParticipant({ from: r.thread.id, to: r.threadParticipant.threadId }),
		routineExecution: r.one.routineExecution({
			from: r.thread.id,
			to: r.routineExecution.threadId,
		}),
	},
	pod: {
		agents: r.many.agent({ from: r.pod.id, to: r.agent.podId }),
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
	},
	threadParticipant: {
		user: r.one.user({ from: r.threadParticipant.userId, to: r.user.id }),
		agent: r.one.agent({ from: r.threadParticipant.agentId, to: r.agent.id }),
	},
	toolCall: {
		decidedBy: r.one.user({ from: r.toolCall.decidedById, to: r.user.id }),
	},
	collaboration: {
		collaborator: r.one.agent({
			from: r.collaboration.collaboratorAgentId,
			to: r.agent.id,
			optional: false,
		}),
	},
}));
