/**
 * The chat-reads operations' contracts, and their entries in the exposure
 * manifest: what members read of chats and the files in them, written files
 * among them, and how much across a workspace waits for them.
 * `index.ts` spreads both, so adding an operation here touches no other file.
 */

import { Schema, Stream } from "effect";
import {
	attentionCountsSchema,
	attentionMarksSchema,
	chatHistoryPageSchema,
	chatMessagesPageSchema,
	chatPageQuerySchema,
	projectChatListSchema,
	workspaceApprovalsSchema,
} from "../chats.ts";
import { ChatFileNotFound, InvalidCursor } from "../errors/chat-reads.ts";
import { ActionForbidden, BotCannotReach, ResourceHidden } from "../errors/proofs.ts";
import { listedFileSchema, listedFileVersionSchema, writtenFileSchema } from "../files.ts";
import { chatContextSchema, chatDetailsSchema, chatHistoryQuerySchema } from "../messages.ts";
import { uuidSchema } from "../uuid.ts";
import { workspaceIdOrSlugSchema } from "../workspaces.ts";
import type { DomainExposure } from "./exposure.ts";
import { OperationContract } from "./operation.ts";

/** How an operation that proves it reaches a chat, project or file refuses. */
const reachRefusals = [ResourceHidden, BotCannotReach] as const;

/** How an operation that proves what it may read in a workspace refuses. */
const workspaceRefusals = [ResourceHidden, ActionForbidden] as const;

/** A chat, by its id. */
const aChat = Schema.Struct({ chatId: Schema.String });

/** A workspace, by its id or its address. */
const aWorkspace = Schema.Struct({ workspace: workspaceIdOrSlugSchema });

/** A file a bot wrote, by its id. */
const aWrittenFile = Schema.Struct({ fileId: uuidSchema });

/** One version of a file a bot wrote: numbered from 1, the first. */
const aVersion = Schema.Struct({
	fileId: uuidSchema,
	version: Schema.Int.check(Schema.isGreaterThan(0)),
});

/** A file's bytes as they are read, which the HTTP API sends on as they come. */
const fileBytesSchema = Schema.declare(
	(input): input is Stream.Stream<Uint8Array, unknown> => Stream.isStream(input),
	{ title: "FileBytes" },
);

/** A file in a chat being read: what it is, and its bytes. */
const chatFileSchema = Schema.Struct({
	id: Schema.String,
	/** An attachment's name. */
	name: Schema.UndefinedOr(Schema.String),
	contentType: Schema.String,
	/** In bytes. */
	size: Schema.Number,
	stream: fileBytesSchema,
});

export const chatReadsContracts = {
	"chats.projectChats": OperationContract.make("chats.projectChats", {
		description:
			"List a project's chats and automations, newest message first, with what you haven't read. A bot's are its default project's.",
		input: Schema.Struct({ projectId: Schema.String }),
		output: projectChatListSchema,
		errors: reachRefusals,
		changes: false,
	}),
	"chats.attention": OperationContract.make("chats.attention", {
		description:
			"How much in a workspace waits for you: approvals you may decide, and unread messages and automation results that mention you.",
		input: aWorkspace,
		output: attentionCountsSchema,
		errors: workspaceRefusals,
		changes: false,
	}),
	"chats.attentionMarks": OperationContract.make("chats.attentionMarks", {
		description:
			"How each project you reach in a workspace, bots' included, stands for you: unread messages, approvals waiting on you, and automations failing unseen.",
		input: aWorkspace,
		output: attentionMarksSchema,
		errors: workspaceRefusals,
		changes: false,
	}),
	"chats.approvals": OperationContract.make("chats.approvals", {
		description:
			"The approvals in a workspace waiting on a decision you may make, and the latest answered in chats you reach.",
		input: aWorkspace,
		output: workspaceApprovalsSchema,
		errors: workspaceRefusals,
		changes: false,
	}),
	"chats.messages": OperationContract.make("chats.messages", {
		description:
			"A page of a chat's messages and its automations' runs, newest last, before the cursor given.",
		input: Schema.Struct({ chatId: Schema.String, ...chatPageQuerySchema.fields }),
		output: chatMessagesPageSchema,
		errors: [...reachRefusals, InvalidCursor],
		changes: false,
	}),
	"chats.history": OperationContract.make("chats.history", {
		description:
			"A page of the automation runs listed in a chat, newest activity first, before the cursor given.",
		input: Schema.Struct({ chatId: Schema.String, ...chatPageQuerySchema.fields }),
		output: chatHistoryPageSchema,
		errors: [...reachRefusals, InvalidCursor],
		changes: false,
	}),
	"chats.file": OperationContract.make("chats.file", {
		description: "A file attached to a message in a chat, with its own media type.",
		input: Schema.Struct({ chatId: Schema.String, fileId: Schema.String }),
		output: chatFileSchema,
		errors: [...reachRefusals, ChatFileNotFound],
		changes: false,
	}),
	"chats.get": OperationContract.make("chats.get", {
		description:
			"A chat with a page of its messages, who has taken part and read it, its project's bots, and what you may decide of its approvals.",
		input: Schema.Struct({ chatId: Schema.String, ...chatHistoryQuerySchema.fields }),
		output: chatDetailsSchema,
		errors: [...reachRefusals, InvalidCursor],
		changes: false,
	}),
	"chats.context": OperationContract.make("chats.context", {
		description:
			"How much of its bot's context window a chat fills. Nothing until a reply in it has been measured.",
		input: aChat,
		output: Schema.NullOr(chatContextSchema),
		errors: reachRefusals,
		changes: false,
	}),
	"files.listInProject": OperationContract.make("files.listInProject", {
		description:
			"List the files uploaded or made in a project's chats, and what was opened from them, newest change first.",
		input: Schema.Struct({ projectId: uuidSchema }),
		output: Schema.Array(listedFileSchema),
		errors: reachRefusals,
		changes: false,
	}),
	"files.get": OperationContract.make("files.get", {
		description: "A file a bot wrote, at its current version.",
		input: aWrittenFile,
		output: writtenFileSchema,
		errors: reachRefusals,
		changes: false,
	}),
	"files.versions": OperationContract.make("files.versions", {
		description: "The versions of a file a bot wrote, newest first.",
		input: aWrittenFile,
		output: Schema.Array(listedFileVersionSchema),
		errors: reachRefusals,
		changes: false,
	}),
	"files.getVersion": OperationContract.make("files.getVersion", {
		description: "One version of a file a bot wrote.",
		input: aVersion,
		output: writtenFileSchema,
		errors: reachRefusals,
		changes: false,
	}),
	"files.pageAddress": OperationContract.make("files.pageAddress", {
		description:
			"Where a version of an HTML page a bot wrote opens, for the next few minutes, on the server's content origin. Nothing when the server has none, or the file is not a page.",
		input: aVersion,
		output: Schema.Struct({ url: Schema.NullOr(Schema.String) }),
		errors: reachRefusals,
		changes: false,
	}),
} as const;

/** Held back: a bot reads the chat it works in from its turn, and others wait for tools to become operations. */
const readInTurn = {
	kind: "heldBack",
	reason:
		"A bot reads the chat it works in as its turn's context; reading other chats waits for tools to become operations.",
} as const;

/** Held back: what waits for a member, which a Personal Assistant reads for its member through its own tool. */
const whatWaitsForYou = {
	kind: "heldBack",
	reason:
		"It is what waits for a member; until tools become operations, a Personal Assistant's workspace_guide tool tells its member, through AssistantGuide.",
} as const;

/** Held back until tools become operations: a bot's file tools read the files of the chat it works in. */
const readByFileTools = {
	kind: "heldBack",
	reason:
		"Until tools become operations: a bot's file tools read the files written where it works, through Files.Authoring.",
} as const;

export const chatReadsExposure = {
	"chats.projectChats": {
		http: { kind: "offered", endpoint: "chats.projectChats" },
		botLoop: readInTurn,
	},
	"chats.attention": {
		http: { kind: "offered", endpoint: "chats.attention" },
		botLoop: whatWaitsForYou,
	},
	"chats.attentionMarks": {
		http: { kind: "offered", endpoint: "chats.attentionMarks" },
		botLoop: whatWaitsForYou,
	},
	"chats.approvals": {
		http: { kind: "offered", endpoint: "chats.approvals" },
		botLoop: whatWaitsForYou,
	},
	"chats.messages": { http: { kind: "offered", endpoint: "chats.messages" }, botLoop: readInTurn },
	"chats.history": { http: { kind: "offered", endpoint: "chats.history" }, botLoop: readInTurn },
	"chats.file": {
		http: { kind: "offered", endpoint: "chats.file" },
		botLoop: {
			kind: "heldBack",
			reason:
				"It is a file's bytes, for a browser; a bot reads the files in its chat with its own tools.",
		},
	},
	"chats.get": { http: { kind: "offered", endpoint: "chats.get" }, botLoop: readInTurn },
	"chats.context": {
		http: { kind: "offered", endpoint: "chats.context" },
		botLoop: {
			kind: "heldBack",
			reason: "It is the meter the web app shows; the bot loop measures a turn's context itself.",
		},
	},
	"files.listInProject": {
		http: { kind: "offered", endpoint: "files.listInProject" },
		botLoop: readByFileTools,
	},
	"files.get": { http: { kind: "offered", endpoint: "files.get" }, botLoop: readByFileTools },
	"files.versions": {
		http: { kind: "offered", endpoint: "files.versions" },
		botLoop: readByFileTools,
	},
	"files.getVersion": {
		http: { kind: "offered", endpoint: "files.getVersion" },
		botLoop: readByFileTools,
	},
	"files.pageAddress": {
		http: { kind: "offered", endpoint: "files.pageAddress" },
		botLoop: {
			kind: "heldBack",
			reason: "A page's address is for a member's browser to open; a bot reads the file itself.",
		},
	},
} as const satisfies DomainExposure<typeof chatReadsContracts>;
