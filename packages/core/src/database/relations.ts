import { defineRelations } from "drizzle-orm";
import * as schema from "./schema.ts";

/**
 * The joins relational queries (`db.query`) may follow, which is how a view
 * reads a conversation and everything it shows in one statement.
 */
export const relations = defineRelations(schema, (r) => ({
	placedConversation: {
		workspace: r.one.workspace({
			from: r.placedConversation.workspaceId,
			to: r.workspace.id,
			optional: false,
		}),
		// Only on a channel's conversation.
		channel: r.one.channel({ from: r.placedConversation.channelId, to: r.channel.id }),
		// On a direct message between people: everybody in it.
		directMessageMembers: r.many.user({
			from: r.placedConversation.id.through(r.directMessageMember.conversationId),
			to: r.user.id.through(r.directMessageMember.userId),
		}),
		messages: r.many.message({ from: r.placedConversation.id, to: r.message.conversationId }),
		participants: r.many.conversationParticipant({
			from: r.placedConversation.id,
			to: r.conversationParticipant.conversationId,
		}),
		reads: r.many.conversationRead({
			from: r.placedConversation.id,
			to: r.conversationRead.conversationId,
		}),
		automationRun: r.one.automationRun({
			from: r.placedConversation.id,
			to: r.automationRun.conversationId,
		}),
		compaction: r.one.conversationCompaction({
			from: r.placedConversation.id,
			to: r.conversationCompaction.conversationId,
		}),
		bot: r.one.bot({ from: r.placedConversation.botId, to: r.bot.id }),
		// On a conversation people open: every conversation in it, its own included.
		rootedConversations: r.many.placedConversation({
			from: r.placedConversation.id,
			to: r.placedConversation.rootConversationId,
		}),
	},
	channel: {
		bots: r.many.bot({
			from: r.channel.id.through(r.channelBot.channelId),
			to: r.bot.id.through(r.channelBot.botId),
		}),
		members: r.many.user({
			from: r.channel.id.through(r.channelMember.channelId),
			to: r.user.id.through(r.channelMember.userId),
		}),
	},
	message: {
		authorUser: r.one.user({ from: r.message.authorUserId, to: r.user.id }),
		authorBot: r.one.bot({ from: r.message.authorBotId, to: r.bot.id }),
		turn: r.one.turn({ from: r.message.turnId, to: r.turn.id }),
		toolCalls: r.many.toolCall({ from: r.message.id, to: r.toolCall.messageId }),
		files: r.many.file({ from: r.message.id, to: r.file.messageId }),
		collaborations: r.many.collaboration({
			from: r.message.id,
			to: r.collaboration.parentMessageId,
		}),
		automationRun: r.one.automationRun({
			from: r.message.runId,
			to: r.automationRun.id,
		}),
		replyTo: r.one.message({ from: r.message.replyToMessageId, to: r.message.id }),
		reactions: r.many.messageReaction({ from: r.message.id, to: r.messageReaction.messageId }),
	},
	messageReaction: {
		user: r.one.user({ from: r.messageReaction.userId, to: r.user.id, optional: false }),
	},
	conversationRead: {
		user: r.one.user({ from: r.conversationRead.userId, to: r.user.id, optional: false }),
	},
	conversationParticipant: {
		user: r.one.user({ from: r.conversationParticipant.userId, to: r.user.id }),
		bot: r.one.bot({ from: r.conversationParticipant.botId, to: r.bot.id }),
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
		collaborator: r.one.bot({
			from: r.collaboration.collaboratorBotId,
			to: r.bot.id,
			optional: false,
		}),
	},
}));
