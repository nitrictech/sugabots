/**
 * The chats operations' contracts, and their entries in the exposure manifest:
 * what changes a chat, its messages, read cursors and files, a written file's
 * deletion among them. Reading them is `chat-reads.ts`'s.
 * `index.ts` spreads both, so adding an operation here touches no other file.
 */

import { Schema, Stream } from "effect";
import { uploadAttachmentQuerySchema, uploadedAttachmentSchema } from "../attachments.ts";
import {
	automationFeedSchema,
	chatNameSchema,
	firstChatMessageSchema,
	projectChatSchema,
	startedChatSchema,
} from "../chats.ts";
import {
	BotHasNoModel,
	FileTooLarge,
	MessageIdConflict,
	MessageNotFinished,
	ReplyTargetNotFound,
	TooManyReactionEmoji,
	TooManyUnsentAttachments,
	UnsentAttachmentsNotFound,
	UploadInterrupted,
} from "../errors/chats.ts";
import { ActionForbidden, BotCannotReach, ResourceHidden } from "../errors/proofs.ts";
import {
	messageReactionsSchema,
	messageSchema,
	newMessageSchema,
	reactionEmojiSchema,
} from "../messages.ts";
import { uuidSchema } from "../uuid.ts";
import { workspaceIdOrSlugSchema } from "../workspaces.ts";
import type { DomainExposure } from "./exposure.ts";
import { OperationContract } from "./operation.ts";

/** How an operation that proves it reaches a chat or project, or something in one, refuses. */
const reachRefusals = [ResourceHidden, BotCannotReach] as const;

/** How an operation that proves it reaches a chat or project, and may act there, refuses. */
const refusals = [...reachRefusals, ActionForbidden] as const;

/** How an operation that proves what it may do in a workspace refuses. */
const workspaceRefusals = [ResourceHidden, ActionForbidden] as const;

/** A chat, by its id. */
const aChat = Schema.Struct({ chatId: Schema.String });

/** A reaction: one emoji on a message. */
const aReaction = Schema.Struct({ messageId: Schema.String, emoji: reactionEmojiSchema });

/** A file's bytes as they arrive, which fail with `UploadInterrupted` if they stop short. */
const uploadedBytesSchema = Schema.declare(
	(input): input is Stream.Stream<Uint8Array, UploadInterrupted> => Stream.isStream(input),
	{ title: "UploadedBytes" },
);

export const chatsContracts = {
	"chats.startInterview": OperationContract.make("chats.startInterview", {
		description:
			"Start the chat in which a bot you just made interviews you to write its instructions. Nothing when it isn't due one.",
		input: Schema.Struct({ botId: Schema.String }),
		output: Schema.NullOr(projectChatSchema),
		errors: workspaceRefusals,
		changes: true,
	}),
	"chats.openAutomationFeed": OperationContract.make("chats.openAutomationFeed", {
		description: "The feed where an automation's runs post, opened the first time it is asked for.",
		input: Schema.Struct({ workspace: workspaceIdOrSlugSchema, automationId: Schema.String }),
		output: automationFeedSchema,
		errors: [ResourceHidden],
		changes: true,
	}),
	"chats.startProjectChat": OperationContract.make("chats.startProjectChat", {
		description:
			"Start a chat in a project, for everyone in it, with its first message, which its lead bot answers unless it mentions others. A bot's chat starts in its default project.",
		input: Schema.Struct({ projectId: Schema.String, ...firstChatMessageSchema.fields }),
		output: startedChatSchema,
		errors: [...refusals, BotHasNoModel, MessageIdConflict],
		changes: true,
	}),
	"chats.renameChat": OperationContract.make("chats.renameChat", {
		description: "Rename one of a project's chats.",
		input: Schema.Struct({ chatId: Schema.String, ...chatNameSchema.fields }),
		output: Schema.Void,
		errors: refusals,
		changes: true,
	}),
	"chats.setResolved": OperationContract.make("chats.setResolved", {
		description:
			"Mark one of a project's chats resolved, or reopen it. It is reopened when somebody writes in it.",
		input: Schema.Struct({ chatId: Schema.String, resolved: Schema.Boolean }),
		output: Schema.Void,
		errors: refusals,
		changes: true,
	}),
	"chats.markRead": OperationContract.make("chats.markRead", {
		description: "Record that you have read a chat up to its newest finished message.",
		input: aChat,
		output: Schema.Void,
		errors: refusals,
		changes: true,
	}),
	"chats.markNestedChatRead": OperationContract.make("chats.markNestedChatRead", {
		description:
			"Record that you have read one automation run, by its own chat, leaving the feed it is listed in unread.",
		input: aChat,
		output: Schema.Void,
		errors: refusals,
		changes: true,
	}),
	"chats.send": OperationContract.make("chats.send", {
		description:
			"Post a message in a chat, with files you uploaded to it, quoting the message it replies to. The bots it asks then answer. Sending it again returns it unchanged.",
		input: Schema.Struct({ chatId: Schema.String, ...newMessageSchema.fields }),
		output: messageSchema,
		errors: [
			...refusals,
			MessageIdConflict,
			ReplyTargetNotFound,
			UnsentAttachmentsNotFound,
			BotHasNoModel,
		],
		changes: true,
	}),
	"chats.uploadFile": OperationContract.make("chats.uploadFile", {
		description:
			"Upload a file to a chat, to attach to a message you send there. It is kept as the type given, or else the type its name suggests.",
		input: Schema.Struct({
			chatId: Schema.String,
			...uploadAttachmentQuerySchema.fields,
			content: uploadedBytesSchema,
		}),
		output: uploadedAttachmentSchema,
		errors: [...refusals, FileTooLarge, TooManyUnsentAttachments, UploadInterrupted],
		changes: true,
	}),
	"chats.removeFile": OperationContract.make("chats.removeFile", {
		description:
			"Remove one of your uploads to a chat before it is sent. Anything else is left as it is.",
		input: Schema.Struct({ chatId: Schema.String, fileId: Schema.String }),
		output: Schema.Void,
		errors: refusals,
		changes: true,
	}),
	"chats.react": OperationContract.make("chats.react", {
		description:
			"React to a finished message with an emoji, answering with all its reactions. Reacting again with the same one changes nothing.",
		input: aReaction,
		output: messageReactionsSchema,
		errors: [...refusals, MessageNotFinished, TooManyReactionEmoji],
		changes: true,
	}),
	"chats.unreact": OperationContract.make("chats.unreact", {
		description: "Take back your reaction to a message, answering with the reactions left.",
		input: aReaction,
		output: messageReactionsSchema,
		errors: refusals,
		changes: true,
	}),
	"files.remove": OperationContract.make("files.remove", {
		description: "Delete a file a bot wrote, with every version of it.",
		input: Schema.Struct({ fileId: uuidSchema }),
		output: Schema.Void,
		errors: refusals,
		changes: true,
	}),
} as const;

/** Held back until tools become operations: a bot's `tool` does this for its asker today. */
const doneByBotTool = <const Tool extends string, const Service extends string>(
	tool: Tool,
	service: Service,
) =>
	({
		kind: "heldBack",
		reason: `Until tools become operations: a bot's ${tool} tool does this for its asker, through ${service}.`,
	}) as const;

/** Held back: a member's own place in a chat, which a bot reading the chat in its turn has none of. */
const membersOwn = {
	kind: "heldBack",
	reason:
		"It is a member's own: what they have read or uploaded. A bot reads its chat in its turn and attaches files to its reply.",
} as const;

/** Held back: nothing in the bot loop asks for it yet. */
const noToolYet = {
	kind: "heldBack",
	reason: "No tool does this; offering one waits for tools to become operations.",
} as const;

export const chatsExposure = {
	"chats.startInterview": {
		http: { kind: "offered", endpoint: "chats.startInterview" },
		botLoop: {
			kind: "heldBack",
			reason: "A new bot interviews the member who made it, who starts that in the web app.",
		},
	},
	"chats.openAutomationFeed": {
		http: { kind: "offered", endpoint: "chats.openAutomationFeed" },
		botLoop: {
			kind: "heldBack",
			reason:
				"A feed opens when a member first opens it; its runs post there whether or not it is.",
		},
	},
	"chats.startProjectChat": {
		http: { kind: "offered", endpoint: "chats.startProjectChat" },
		botLoop: {
			kind: "heldBack",
			reason:
				"A bot starts a chat with a brief instead, which its start_chat tool writes for its asker through BotChats, until tools become operations.",
		},
	},
	"chats.renameChat": {
		http: { kind: "offered", endpoint: "chats.renameChat" },
		botLoop: noToolYet,
	},
	"chats.setResolved": {
		http: { kind: "offered", endpoint: "chats.markResolved" },
		botLoop: doneByBotTool("mark_resolved", "BotChats"),
	},
	"chats.markRead": {
		http: { kind: "offered", endpoint: "chats.markRead" },
		botLoop: membersOwn,
	},
	"chats.markNestedChatRead": {
		http: { kind: "offered", endpoint: "chats.markNestedChatRead" },
		botLoop: membersOwn,
	},
	"chats.send": {
		http: { kind: "offered", endpoint: "chats.send" },
		botLoop: {
			kind: "heldBack",
			reason:
				"A bot's message is its turn's reply, which the bot loop writes; it posts nothing as its asker.",
		},
	},
	"chats.uploadFile": {
		http: { kind: "offered", endpoint: "chats.uploadFile" },
		botLoop: membersOwn,
	},
	"chats.removeFile": {
		http: { kind: "offered", endpoint: "chats.removeFile" },
		botLoop: membersOwn,
	},
	"chats.react": {
		http: { kind: "offered", endpoint: "chats.react" },
		botLoop: {
			kind: "heldBack",
			reason:
				"A bot reacts only to say it read a message and stays silent, which the bot loop does itself.",
		},
	},
	"chats.unreact": {
		http: { kind: "offered", endpoint: "chats.unreact" },
		botLoop: {
			kind: "heldBack",
			reason: "A reaction taken back is a member's own; a bot takes none back.",
		},
	},
	"files.remove": {
		http: { kind: "offered", endpoint: "files.remove" },
		botLoop: noToolYet,
	},
} as const satisfies DomainExposure<typeof chatsContracts>;
