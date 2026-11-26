/**
 * The chat-reads operations' contracts, each with its decisions in the
 * exposure manifest: what members read of chats and the files in them, written files
 * among them, and how much across a workspace waits for them.
 * `index.ts` spreads them, so adding an operation here touches no other file.
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
import {
	ActionForbidden,
	ApprovalNeeded,
	ApprovalRefused,
	BotCannotReach,
	ResourceHidden,
} from "../errors/proofs.ts";
import { listedFileSchema, listedFileVersionSchema, writtenFileSchema } from "../files.ts";
import { chatContextSchema, chatDetailsSchema, chatHistoryQuerySchema } from "../messages.ts";
import { isoTimestampSchema } from "../timestamps.ts";
import { uuidOrStringSchema, uuidSchema } from "../uuid.ts";
import { workspaceIdOrSlugSchema, workspaceRoleSchema } from "../workspaces.ts";
import { OperationContract } from "./operation.ts";

/** How an operation that proves it reaches a chat, project or file refuses. */
const reachRefusals = [ResourceHidden, BotCannotReach] as const;

/** How an operation that proves what it may read in a workspace refuses. */
const workspaceRefusals = [ResourceHidden, ActionForbidden] as const;

/** A chat, by its id. */
const aChat = Schema.Struct({ chatId: uuidOrStringSchema });

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

export const SEARCH_HISTORY_TOOL = "search_history";
export const READ_CHAT_FILE_TOOL = "read_chat_file";
export const READ_DOCS_TOOL = "read_docs";
const WORKSPACE_ROLE_TOOL = "workspace_role";
export const HISTORY_SEARCH_MAX_MATCHES = 10;
export const CHAT_FILE_READ_DEFAULT_LINES = 2_000;

const turnReadErrors = [...reachRefusals, ApprovalNeeded, ApprovalRefused] as const;
const refused = Schema.Struct({ refused: Schema.String });
const memberRole = Schema.Struct({
	name: Schema.String,
	handle: Schema.String,
	role: Schema.Union([workspaceRoleSchema, Schema.Literal("none")]),
});

/** Held back: a bot reads the chat it works in from its turn, and others wait for tools to become operations. */
const readInTurn = {
	kind: "heldBack",
	reason:
		"A bot reads the chat it works in as its turn's context; reading other chats waits for tools to become operations.",
} as const;

/** Covered: what waits for a member, which a Personal Assistant's workspace guide tells them. */
const whatWaitsForYou = {
	kind: "coveredBy",
	operation: "workspaces.guide",
	reason: "It is what waits for a member, which a Personal Assistant's workspace guide tells them.",
} as const;

const readByFileTools = {
	kind: "heldBack",
	reason:
		"Members use this to browse files and versions. The file tools read written files at their current versions.",
} as const;

const turnReadTool = (tool: string) =>
	({
		http: { kind: "heldBack", reason: "Formats a read for the bot in a turn." },
		botLoop: { kind: "offered", tool, offeredIn: "everywhere", approval: { kind: "never" } },
	}) as const;

export const chatReadsContracts = {
	"chats.searchHistory": OperationContract.make("chats.searchHistory", {
		description: `Search chat messages by words, time range, or both. Leave out chat to search here, give a chat id to search there, or pass "all" to search chats you can reach. In this chat, the search covers earlier messages from before the part you read word for word. Returns up to ${HISTORY_SEARCH_MAX_MATCHES} messages, best first with words or oldest first with only a time range. When searching across chats, each result includes its chat id.`,
		input: Schema.Struct({
			chat: Schema.optional(
				Schema.Union([uuidSchema, Schema.Literal("all")]).annotate({
					description: 'A chat id, or "all" for chats within reach. Leave out to search this chat.',
				}),
			),
			query: Schema.optional(
				Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)).annotate({
					description:
						'Words to look for, like "hotel budget". Supports "quoted phrases", OR, and -excluded words.',
				}),
			),
			after: Schema.optional(
				isoTimestampSchema.annotate({
					description: "Only messages written at or after this time, like 2026-05-15T17:00:00Z.",
				}),
			),
			before: Schema.optional(
				isoTimestampSchema.annotate({
					description: "Only messages written before this time, like 2026-05-15T18:00:00Z.",
				}),
			),
		}),
		output: Schema.Union([
			Schema.Struct({
				messages: Schema.Array(
					Schema.Struct({
						author: Schema.String,
						at: Schema.String,
						text: Schema.String,
						chatId: Schema.optional(uuidSchema),
					}),
				),
				more: Schema.Boolean,
			}),
			refused,
		]),
		errors: turnReadErrors,
		changes: false,
		...turnReadTool(SEARCH_HISTORY_TOOL),
	}),
	"chats.readChatFile": OperationContract.make("chats.readChatFile", {
		description: `Read a file in a chat you can reach, such as an attachment or a kept tool result. Returns up to ${CHAT_FILE_READ_DEFAULT_LINES} numbered lines with the file's total lines and, when there is more, where to continue. Give pattern to find lines containing it. A supported image is shown if your model can see images.`,
		input: Schema.Struct({
			file: uuidSchema.annotate({ description: "The file's id." }),
			chat: Schema.optional(
				uuidSchema.annotate({
					description: "The id of the chat that holds the file, if known.",
				}),
			),
			offset: Schema.optional(
				Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
					description: "The line to start at, counting from 1. Defaults to the first.",
				}),
			),
			limit: Schema.optional(
				Schema.Int.check(
					Schema.isBetween({
						minimum: 1,
						maximum: CHAT_FILE_READ_DEFAULT_LINES,
					}),
				).annotate({
					description: `The most lines to return. Defaults to ${CHAT_FILE_READ_DEFAULT_LINES}.`,
				}),
			),
			pattern: Schema.optional(
				Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)).annotate({
					description:
						"Return only lines containing this text, ignoring case, searching from offset.",
				}),
			),
		}),
		output: Schema.Union([
			Schema.Struct({
				lines: Schema.String,
				totalLines: Schema.Int,
				continueFrom: Schema.optional(Schema.Int),
			}),
			Schema.Struct({
				text: Schema.String,
				images: Schema.Array(Schema.Struct({ data: Schema.String, mediaType: Schema.String })),
			}),
			refused,
		]),
		errors: turnReadErrors,
		changes: false,
		...turnReadTool(READ_CHAT_FILE_TOOL),
	}),
	"chats.readDocs": OperationContract.make("chats.readDocs", {
		description:
			"Read Sugabots' documentation when someone asks how to use it or how it works. Give a page and, to read only part of it, its section headings.",
		input: Schema.Struct({
			page: Schema.String.check(Schema.isMaxLength(200)).annotate({
				description: "The page's name, as listed, like automations.",
			}),
			sections: Schema.optional(
				Schema.Array(Schema.String.check(Schema.isMaxLength(200)))
					.check(Schema.isMaxLength(20))
					.annotate({
						description: "The section headings, as listed. Leave out for the whole page.",
					}),
			),
		}),
		output: Schema.Union([Schema.Struct({ markdown: Schema.String }), refused]),
		errors: turnReadErrors,
		changes: false,
		...turnReadTool(READ_DOCS_TOOL),
	}),
	"chats.workspaceRole": OperationContract.make("chats.workspaceRole", {
		description:
			"Look up a chat participant's workspace role and who can change it. Use when someone can't do something, a setting or tool seems missing, or they want to know who to ask. The docs explain what each role may do.",
		input: Schema.Struct({
			member: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
				description: "The handle of a member in this chat, like @sam.",
			}),
		}),
		output: Schema.Union([
			Schema.Struct({
				member: memberRole,
				canHelp: Schema.Array(memberRole),
				more: Schema.Boolean,
			}),
			refused,
		]),
		errors: turnReadErrors,
		changes: false,
		...turnReadTool(WORKSPACE_ROLE_TOOL),
	}),
	"chats.projectChats": OperationContract.make("chats.projectChats", {
		description:
			"List a project's chats and automations, newest message first, with what you haven't read. A bot's are its default project's.",
		input: Schema.Struct({ projectId: uuidOrStringSchema }),
		output: projectChatListSchema,
		errors: reachRefusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/projects/:projectId/chats" },
		botLoop: readInTurn,
	}),
	"chats.attention": OperationContract.make("chats.attention", {
		description:
			"How much in a workspace waits for you: approvals you may decide, and unread messages and automation results that mention you.",
		input: aWorkspace,
		output: attentionCountsSchema,
		errors: workspaceRefusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/workspaces/:workspace/chats/attention" },
		botLoop: whatWaitsForYou,
	}),
	"chats.attentionMarks": OperationContract.make("chats.attentionMarks", {
		description:
			"How each project you reach in a workspace, bots' included, stands for you: unread messages, approvals waiting on you, and automations failing unseen.",
		input: aWorkspace,
		output: attentionMarksSchema,
		errors: workspaceRefusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/workspaces/:workspace/chats/attention-marks" },
		botLoop: whatWaitsForYou,
	}),
	"chats.approvals": OperationContract.make("chats.approvals", {
		description:
			"The approvals in a workspace waiting on a decision you may make, and the latest answered in chats you reach.",
		input: aWorkspace,
		output: workspaceApprovalsSchema,
		errors: workspaceRefusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/workspaces/:workspace/chats/approvals" },
		botLoop: whatWaitsForYou,
	}),
	"chats.messages": OperationContract.make("chats.messages", {
		description:
			"A page of a chat's messages and its automations' runs, newest last, before the cursor given.",
		input: Schema.Struct({ chatId: uuidOrStringSchema, ...chatPageQuerySchema.fields }),
		output: chatMessagesPageSchema,
		errors: [...reachRefusals, InvalidCursor],
		changes: false,
		http: { kind: "offered", method: "GET", path: "/chats/:chatId/messages" },
		botLoop: readInTurn,
	}),
	"chats.history": OperationContract.make("chats.history", {
		description:
			"A page of the automation runs listed in a chat, newest activity first, before the cursor given.",
		input: Schema.Struct({ chatId: uuidOrStringSchema, ...chatPageQuerySchema.fields }),
		output: chatHistoryPageSchema,
		errors: [...reachRefusals, InvalidCursor],
		changes: false,
		http: { kind: "offered", method: "GET", path: "/chats/:chatId/history" },
		botLoop: readInTurn,
	}),
	"chats.file": OperationContract.make("chats.file", {
		description: "A file attached to a message in a chat, with its own media type.",
		input: Schema.Struct({ chatId: uuidOrStringSchema, fileId: uuidOrStringSchema }),
		output: chatFileSchema,
		errors: [...reachRefusals, ChatFileNotFound],
		changes: false,
		http: {
			kind: "ownEndpoint",
			reason: "It answers with the file's bytes, under the file's own media type and name.",
		},
		botLoop: {
			kind: "heldBack",
			reason:
				"It is a file's bytes, for a browser; a bot reads the files in its chat with its own tools.",
		},
	}),
	"chats.get": OperationContract.make("chats.get", {
		description:
			"A chat with a page of its messages, who has taken part and read it, its project's bots, and what you may decide of its approvals.",
		input: Schema.Struct({ chatId: uuidOrStringSchema, ...chatHistoryQuerySchema.fields }),
		output: chatDetailsSchema,
		errors: [...reachRefusals, InvalidCursor],
		changes: false,
		http: { kind: "offered", method: "GET", path: "/chats/:chatId" },
		botLoop: readInTurn,
	}),
	"chats.context": OperationContract.make("chats.context", {
		description:
			"How much of its bot's context window a chat fills. Nothing until a reply in it has been measured.",
		input: aChat,
		output: Schema.NullOr(chatContextSchema),
		errors: reachRefusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/chats/:chatId/context" },
		botLoop: {
			kind: "heldBack",
			reason: "It is the meter the web app shows; the bot loop measures a turn's context itself.",
		},
	}),
	"files.listInProject": OperationContract.make("files.listInProject", {
		description:
			"List the files uploaded or made in a project's chats, and what was opened from them, newest change first.",
		input: Schema.Struct({ projectId: uuidSchema }),
		output: Schema.Array(listedFileSchema),
		errors: reachRefusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/projects/:projectId/files" },
		botLoop: readByFileTools,
	}),
	"files.get": OperationContract.make("files.get", {
		description: "A file a bot wrote, at its current version.",
		input: aWrittenFile,
		output: writtenFileSchema,
		errors: reachRefusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/files/:fileId" },
		botLoop: readByFileTools,
	}),
	"files.versions": OperationContract.make("files.versions", {
		description: "The versions of a file a bot wrote, newest first.",
		input: aWrittenFile,
		output: Schema.Array(listedFileVersionSchema),
		errors: reachRefusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/files/:fileId/versions" },
		botLoop: readByFileTools,
	}),
	"files.getVersion": OperationContract.make("files.getVersion", {
		description: "One version of a file a bot wrote.",
		input: aVersion,
		output: writtenFileSchema,
		errors: reachRefusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/files/:fileId/versions/:version" },
		botLoop: readByFileTools,
	}),
	"files.pageAddress": OperationContract.make("files.pageAddress", {
		description:
			"Where a version of an HTML page a bot wrote opens, for the next few minutes, on the server's content origin. Nothing when the server has none, or the file is not a page.",
		input: aVersion,
		output: Schema.Struct({ url: Schema.NullOr(Schema.String) }),
		errors: reachRefusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/files/:fileId/versions/:version/page" },
		botLoop: {
			kind: "heldBack",
			reason: "A page's address is for a member's browser to open; a bot reads the file itself.",
		},
	}),
} as const;
