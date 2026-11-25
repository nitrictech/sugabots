import { Schema } from "effect";
import {
	FileContentTooLarge,
	FileEditTextUnmatched,
	FileKindFixed,
	FileStale,
	InvalidFileWrite,
} from "../errors/files.ts";
import {
	ActionForbidden,
	ApprovalNeeded,
	ApprovalRefused,
	BotCannotReach,
	ResourceHidden,
	TurnEnded,
} from "../errors/proofs.ts";
import { TurnExecutionSuperseded } from "../errors/turns.ts";
import {
	FILE_EDIT_TOOL,
	FILE_LIST_TOOL,
	FILE_READ_TOOL,
	FILE_WRITE_TOOL,
	fileContentSchema,
	fileTitleSchema,
	fileWrittenSchema,
	MAX_FILE_CONTENT_CHARACTERS,
	writtenFileKindSchema,
} from "../files.ts";
import { isoTimestampSchema } from "../timestamps.ts";
import { uuidSchema } from "../uuid.ts";
import type { DomainExposure } from "./exposure.ts";
import { OperationContract } from "./operation.ts";

const fileId = uuidSchema.annotate({
	description: "The file's id, from file_list or the write that made it",
});
const baseVersion = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
	description: "The version your change is based on, from file_read or your last write.",
});
const fileListing = Schema.Struct({
	fileId,
	kind: writtenFileKindSchema,
	title: Schema.String,
	version: baseVersion,
	updatedAt: isoTimestampSchema,
});

const KIND_RULES =
	"A `markdown` file is markdown with `#` headings. An `html` page is a complete HTML document, shown in the chat under your reply as well as on its own, so it suits charts, tables and small interactive tools. Make it responsive: it is shown in the chat, opened large beside it and on phones, from about 360px to 1200px wide, so use fluid widths with no fixed or maximum width of its own, let rows wrap or stack when narrow, and size charts and canvases to their container, redrawing when it resizes. It is drawn on the chat's own ground with the app's theme, so it looks part of the chat: leave the page background transparent, add no outer card or border of your own, and colour it with the app's CSS variables, which follow light and dark mode: --foreground, --body-foreground, --muted-foreground, --subtle-foreground for text; --card, --panel, --chip, --hover for surfaces; --border, --border-strong; --primary, --link, --success-text, --destructive-text, --warning for accents; and --font-sans, --font-mono. It runs in an isolated frame with no network access except scripts from https://cdn.jsdelivr.net (such as Chart.js), so inline its CSS and embed its data.";

const readErrors = [ResourceHidden, BotCannotReach, ApprovalNeeded, ApprovalRefused] as const;
const writeErrors = [
	...readErrors,
	ActionForbidden,
	TurnEnded,
	TurnExecutionSuperseded,
	FileStale,
	FileContentTooLarge,
] as const;

export const filesContracts = {
	"files.servePage": OperationContract.make("files.servePage", {
		description: "Serve the version of an HTML page that its content-origin address opens.",
		input: Schema.Struct({ fileId }),
		output: Schema.Struct({ title: Schema.String, html: Schema.String }),
		errors: [ResourceHidden],
		changes: false,
	}),
	"files.listWritten": OperationContract.make("files.listWritten", {
		description:
			"List the documents and pages written in the project this chat works in, newest first.",
		input: Schema.Record(Schema.String, Schema.Never),
		output: Schema.Struct({ files: Schema.Array(fileListing) }),
		errors: readErrors,
		changes: false,
	}),
	"files.readWritten": OperationContract.make("files.readWritten", {
		description:
			"Read the current content and version of a document or page from file_list. A file on a message is read with read_chat_file.",
		input: Schema.Struct({ fileId }),
		output: Schema.Struct({
			status: Schema.Literal("found"),
			...fileListing.fields,
			content: Schema.String,
		}),
		errors: readErrors,
		changes: false,
	}),
	"files.write": OperationContract.make("files.write", {
		description: `Write a file for work members will come back to, such as a plan, report, notes or page. To create one, provide \`kind\` and \`title\`. To replace the content of an existing file as a new version, provide its \`fileId\` and \`baseVersion\`. Use file_edit for a small change. ${KIND_RULES}`,
		input: Schema.Struct({
			fileId: Schema.optionalKey(Schema.Union([fileId, Schema.Literal("")])),
			baseVersion: Schema.optionalKey(baseVersion),
			kind: Schema.optionalKey(
				writtenFileKindSchema.annotate({
					description: "Needed when creating. A file's kind stays fixed.",
				}),
			),
			title: Schema.optionalKey(fileTitleSchema),
			content: fileContentSchema,
		}),
		output: fileWrittenSchema,
		errors: [...writeErrors, FileKindFixed, InvalidFileWrite],
		changes: true,
	}),
	"files.edit": OperationContract.make("files.edit", {
		description:
			"Change part of a file as a new version by replacing oldText with newText. Quote enough of the content from file_read or your last write for oldText to appear exactly once.",
		input: Schema.Struct({
			fileId,
			baseVersion,
			oldText: Schema.String.check(
				Schema.isMinLength(1),
				Schema.isMaxLength(MAX_FILE_CONTENT_CHARACTERS),
			),
			newText: fileContentSchema,
		}),
		output: fileWrittenSchema,
		errors: [...writeErrors, FileEditTextUnmatched],
		changes: true,
	}),
} as const;

const modelOnly = {
	kind: "heldBack",
	reason: "This tool acts in the bot's turn. Members use the project and chat file endpoints.",
} as const;
/**
 * inTurn sets the file tools' approval to `never`. `approvalNeed` still asks for
 * changes by a Personal Assistant or a turn that inherits its rule through a
 * brief. It asks for every call in a Personal Assistant's webhook or GitHub run.
 */
const inTurn = { kind: "offered", offeredIn: "everywhere", approval: { kind: "never" } } as const;

const contentOriginOnly = {
	kind: "heldBack",
	reason: "Only the content origin serves pages from their secret addresses.",
} as const;

export const filesExposure = {
	"files.servePage": { http: contentOriginOnly, botLoop: contentOriginOnly },
	"files.listWritten": { http: modelOnly, botLoop: { ...inTurn, tool: FILE_LIST_TOOL } },
	"files.readWritten": { http: modelOnly, botLoop: { ...inTurn, tool: FILE_READ_TOOL } },
	"files.write": { http: modelOnly, botLoop: { ...inTurn, tool: FILE_WRITE_TOOL } },
	"files.edit": { http: modelOnly, botLoop: { ...inTurn, tool: FILE_EDIT_TOOL } },
} as const satisfies DomainExposure<typeof filesContracts>;
