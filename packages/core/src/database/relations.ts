import { defineRelations } from "drizzle-orm";
import * as schema from "./schema.ts";

/**
 * The joins relational queries (`db.query`) may follow, which is how a view
 * reads a chat and everything it shows in one statement.
 */
export const relations = defineRelations(schema, (r) => ({
	placedChat: {
		workspace: r.one.workspace({
			from: r.placedChat.workspaceId,
			to: r.workspace.id,
			optional: false,
		}),
		// On a project's chat, and an automation's feed and runs.
		project: r.one.project({ from: r.placedChat.projectId, to: r.project.id }),
		messages: r.many.message({ from: r.placedChat.id, to: r.message.chatId }),
		participants: r.many.chatParticipant({
			from: r.placedChat.id,
			to: r.chatParticipant.chatId,
		}),
		reads: r.many.chatRead({
			from: r.placedChat.id,
			to: r.chatRead.chatId,
		}),
		automationRun: r.one.automationRun({
			from: r.placedChat.id,
			to: r.automationRun.chatId,
		}),
		compaction: r.one.chatCompaction({
			from: r.placedChat.id,
			to: r.chatCompaction.chatId,
		}),
		bot: r.one.bot({ from: r.placedChat.botId, to: r.bot.id }),
		// On a chat people open: every chat in it, its own included.
		rootedChats: r.many.placedChat({
			from: r.placedChat.id,
			to: r.placedChat.rootChatId,
		}),
	},
	bot: {
		// None for a system bot.
		defaultProject: r.one.project({ from: r.bot.id, to: r.project.defaultOfBotId }),
	},
	project: {
		bots: r.many.bot({
			from: r.project.id.through(r.projectBot.projectId),
			to: r.bot.id.through(r.projectBot.botId),
		}),
		members: r.many.person({
			from: r.project.id.through(r.projectMember.projectId),
			to: r.person.id.through(r.projectMember.personId),
		}),
	},
	message: {
		authorPerson: r.one.person({ from: r.message.authorPersonId, to: r.person.id }),
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
		// One of the two, by `message_reaction_one_reactor`.
		person: r.one.person({ from: r.messageReaction.personId, to: r.person.id }),
		bot: r.one.bot({ from: r.messageReaction.botId, to: r.bot.id }),
	},
	chatRead: {
		person: r.one.person({ from: r.chatRead.personId, to: r.person.id, optional: false }),
	},
	chatParticipant: {
		person: r.one.person({ from: r.chatParticipant.personId, to: r.person.id }),
		bot: r.one.bot({ from: r.chatParticipant.botId, to: r.bot.id }),
	},
	toolCall: {
		decidedBy: r.one.person({ from: r.toolCall.decidedById, to: r.person.id }),
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
